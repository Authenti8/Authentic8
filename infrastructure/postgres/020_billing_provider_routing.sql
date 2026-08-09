BEGIN;

ALTER TABLE billing_provider_payments
  ADD COLUMN IF NOT EXISTS checkout_intent_id UUID
  REFERENCES billing_checkout_sessions(id) ON DELETE SET NULL;

ALTER TABLE billing_provider_subscriptions
  ADD COLUMN IF NOT EXISTS checkout_intent_id UUID
  REFERENCES billing_checkout_sessions(id) ON DELETE SET NULL;

UPDATE billing_provider_subscriptions mapping
SET checkout_intent_id = subscription.provider_checkout_intent_id, updated_at = now()
FROM subscriptions subscription
WHERE subscription.provider_subscription_id = mapping.provider_subscription_id
  AND subscription.provider_checkout_intent_id IS NOT NULL
  AND mapping.checkout_intent_id IS NULL;

UPDATE billing_provider_payments payment
SET checkout_intent_id = subscription.provider_checkout_intent_id, updated_at = now()
FROM subscriptions subscription
WHERE payment.organization_id = subscription.organization_id
  AND payment.provider_subscription_id = subscription.provider_subscription_id
  AND subscription.provider_checkout_intent_id IS NOT NULL
  AND payment.checkout_intent_id IS NULL;

CREATE OR REPLACE FUNCTION authenti8_track_provider_subscription() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE provider_id TEXT; checkout_id UUID;
BEGIN
  provider_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.provider_subscription_id
    ELSE COALESCE(NEW.provider_subscription_id, OLD.provider_subscription_id) END;
  checkout_id := CASE
    WHEN TG_OP = 'INSERT' THEN NEW.provider_checkout_intent_id
    WHEN NEW.provider_subscription_id IS NOT NULL THEN
      COALESCE(NEW.provider_checkout_intent_id, OLD.provider_checkout_intent_id)
    ELSE OLD.provider_checkout_intent_id END;
  IF provider_id IS NOT NULL THEN
    INSERT INTO billing_provider_subscriptions(
      provider_subscription_id, organization_id, checkout_intent_id)
    VALUES (provider_id, NEW.organization_id, checkout_id)
    ON CONFLICT (provider_subscription_id) DO UPDATE SET
      organization_id = EXCLUDED.organization_id,
      checkout_intent_id = COALESCE(EXCLUDED.checkout_intent_id,
        billing_provider_subscriptions.checkout_intent_id),
      updated_at = now();
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION authenti8_track_provider_payment_subscription() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE checkout_id UUID;
BEGIN
  IF NEW.provider_subscription_id IS NULL OR NEW.purpose <> 'PROFESSIONAL' THEN RETURN NEW; END IF;
  checkout_id := NEW.checkout_intent_id;
  IF checkout_id IS NULL THEN
    SELECT mapping.checkout_intent_id INTO checkout_id
    FROM billing_provider_subscriptions mapping
    WHERE mapping.provider_subscription_id = NEW.provider_subscription_id;
  END IF;
  INSERT INTO billing_provider_subscriptions(
    provider_subscription_id, organization_id, checkout_intent_id)
  VALUES (NEW.provider_subscription_id, NEW.organization_id, checkout_id)
  ON CONFLICT (provider_subscription_id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    checkout_intent_id = COALESCE(
      billing_provider_subscriptions.checkout_intent_id, EXCLUDED.checkout_intent_id),
    updated_at = now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION authenti8_bind_payment_checkout() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.checkout_intent_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT checkout.id INTO NEW.checkout_intent_id
  FROM billing_webhook_events event
  JOIN billing_checkout_sessions checkout
    ON checkout.organization_id = NEW.organization_id
    AND ((COALESCE(event.payload->>'checkoutIntentId', '') <> ''
        AND checkout.id = (event.payload->>'checkoutIntentId')::UUID)
      OR (COALESCE(event.payload->>'checkoutSessionId', '') <> ''
        AND checkout.provider_session_id = event.payload->>'checkoutSessionId'))
  WHERE event.provider = 'DODO'
    AND event.payload->>'paymentId' = NEW.payment_id
  ORDER BY event.processed_at DESC LIMIT 1;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS authenti8_bind_payment_checkout_trigger
  ON billing_provider_payments;
CREATE TRIGGER authenti8_bind_payment_checkout_trigger
BEFORE INSERT OR UPDATE OF provider_subscription_id ON billing_provider_payments
FOR EACH ROW EXECUTE FUNCTION authenti8_bind_payment_checkout();

DROP TRIGGER IF EXISTS authenti8_track_provider_payment_subscription_trigger
  ON billing_provider_payments;
CREATE TRIGGER authenti8_track_provider_payment_subscription_trigger
AFTER INSERT OR UPDATE OF provider_subscription_id ON billing_provider_payments
FOR EACH ROW EXECUTE FUNCTION authenti8_track_provider_payment_subscription();

CREATE OR REPLACE FUNCTION authenti8_billing_subscription_context(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('organizationId', mapping.organization_id,
    'checkoutIntentId', checkout.id, 'checkoutSessionId', checkout.provider_session_id)
  FROM billing_provider_subscriptions mapping
  LEFT JOIN billing_checkout_sessions checkout ON checkout.id = mapping.checkout_intent_id
  WHERE mapping.provider_subscription_id = input->>'subscriptionId'
$$;

CREATE OR REPLACE FUNCTION authenti8_begin_checkout(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID; account_email TEXT; intent billing_checkout_sessions;
  subscription_status TEXT; subscription_plan TEXT; provider_subscription TEXT;
BEGIN
  SELECT member.organization_id, account.email INTO org, account_email
  FROM organization_members member JOIN users account ON account.id = member.user_id
  WHERE member.user_id = (input->>'userId')::UUID AND member.role IN ('OWNER', 'ADMIN')
  ORDER BY member.created_at LIMIT 1;
  IF org IS NULL THEN RETURN NULL; END IF;
  PERFORM id FROM organizations WHERE id = org FOR UPDATE;
  SELECT status, plan_key, provider_subscription_id
  INTO subscription_status, subscription_plan, provider_subscription
  FROM subscriptions WHERE organization_id = org ORDER BY updated_at DESC LIMIT 1;
  IF input->>'purpose' = 'EXTRA_CREDITS'
    AND COALESCE(subscription_status, '') NOT IN ('ACTIVE', 'TRIALING') THEN
    RETURN jsonb_build_object('reason', 'INACTIVE_SUBSCRIPTION');
  END IF;
  IF input->>'purpose' = 'EXTRA_CREDITS'
    AND COALESCE(subscription_plan, '') NOT IN ('STARTER', 'PROFESSIONAL') THEN
    RETURN jsonb_build_object('reason', 'UNSUPPORTED_PLAN');
  END IF;
  IF input->>'purpose' = 'PROFESSIONAL'
    AND subscription_status IN ('ACTIVE', 'TRIALING')
    AND subscription_plan = 'PROFESSIONAL' THEN
    RETURN jsonb_build_object('reason', 'ACTIVE_PLAN');
  END IF;
  IF input->>'purpose' = 'PROFESSIONAL' AND subscription_status = 'PAST_DUE'
    AND provider_subscription IS NOT NULL THEN
    RETURN jsonb_build_object('reason', 'EXISTING_SUBSCRIPTION');
  END IF;
  IF input->>'purpose' = 'PROFESSIONAL' THEN
    UPDATE billing_checkout_sessions SET status = 'FAILED', updated_at = now()
    WHERE organization_id = org AND purpose = 'PROFESSIONAL' AND status = 'PENDING'
      AND created_at <= now() - interval '30 minutes';
    SELECT * INTO intent FROM billing_checkout_sessions
    WHERE organization_id = org AND purpose = 'PROFESSIONAL' AND status = 'PENDING'
    ORDER BY created_at DESC LIMIT 1;
    IF intent.id IS NOT NULL THEN
      RETURN jsonb_build_object('organizationId', org, 'email', account_email,
        'checkoutIntentId', intent.id, 'reused', true);
    END IF;
    SELECT * INTO intent FROM billing_checkout_sessions
    WHERE organization_id = org AND purpose = 'PROFESSIONAL' AND status = 'COMPLETED'
    ORDER BY updated_at DESC LIMIT 1;
    IF intent.id IS NOT NULL THEN
      RETURN jsonb_build_object('reason', 'ACTIVATION_PENDING');
    END IF;
  END IF;
  INSERT INTO billing_checkout_sessions(organization_id, provider, provider_session_id,
    purpose, quantity) VALUES (org, 'DODO', 'intent:' || gen_random_uuid(),
    input->>'purpose', COALESCE((input->>'quantity')::INTEGER, 1)) RETURNING * INTO intent;
  RETURN jsonb_build_object('organizationId', org, 'email', account_email,
    'checkoutIntentId', intent.id);
END $$;

CREATE OR REPLACE FUNCTION authenti8_apply_dunning_recovery(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID; subscription_row subscriptions; provider_row billing_provider_subscriptions;
  inserted INTEGER; occurred_at TIMESTAMPTZ :=
    COALESCE((input->>'occurredAt')::TIMESTAMPTZ, now());
BEGIN
  SELECT * INTO provider_row FROM billing_provider_subscriptions
  WHERE provider_subscription_id = input->>'subscriptionId';
  org := provider_row.organization_id;
  IF org IS NULL THEN
    RETURN jsonb_build_object('ignored', true, 'reason', 'UNKNOWN_SUBSCRIPTION');
  END IF;
  SELECT * INTO subscription_row FROM subscriptions WHERE organization_id = org FOR UPDATE;
  IF subscription_row.provider_subscription_id IS NOT NULL
    AND subscription_row.provider_subscription_id <> input->>'subscriptionId' THEN
    RETURN jsonb_build_object('ignored', true, 'reason', 'SUPERSEDED_SUBSCRIPTION');
  END IF;
  IF EXISTS (
    SELECT 1 FROM billing_checkout_sessions candidate
    LEFT JOIN billing_checkout_sessions original ON original.id = provider_row.checkout_intent_id
    WHERE candidate.organization_id = org AND candidate.purpose = 'PROFESSIONAL'
      AND candidate.id IS DISTINCT FROM provider_row.checkout_intent_id
      AND ((provider_row.checkout_intent_id IS NULL
          AND candidate.status IN ('PENDING', 'COMPLETED'))
        OR (provider_row.checkout_intent_id IS NOT NULL
          AND candidate.status IN ('PENDING', 'COMPLETED', 'ACTIVATED')
          AND candidate.created_at > original.created_at))
  ) THEN
    RETURN jsonb_build_object('ignored', true, 'reason', 'SUPERSEDED_SUBSCRIPTION');
  END IF;
  INSERT INTO billing_webhook_events(provider, event_id, event_type, payload)
  VALUES ('DODO', input->>'eventId', 'dunning.recovered', input)
  ON CONFLICT DO NOTHING; GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN RETURN jsonb_build_object('duplicate', true); END IF;
  IF COALESCE(input->>'paymentId', '') <> '' THEN
    INSERT INTO billing_provider_payments(payment_id, organization_id,
      provider_subscription_id, checkout_intent_id, purpose, quantity, event_occurred_at)
    VALUES (input->>'paymentId', org, input->>'subscriptionId',
      provider_row.checkout_intent_id, 'PROFESSIONAL', 1, occurred_at)
    ON CONFLICT (payment_id) DO UPDATE SET
      provider_subscription_id = EXCLUDED.provider_subscription_id,
      checkout_intent_id = COALESCE(EXCLUDED.checkout_intent_id,
        billing_provider_payments.checkout_intent_id),
      event_occurred_at = GREATEST(EXCLUDED.event_occurred_at,
        billing_provider_payments.event_occurred_at), updated_at = now();
  END IF;
  UPDATE subscriptions SET provider = 'DODO',
    provider_subscription_id = input->>'subscriptionId',
    provider_checkout_intent_id = COALESCE(provider_checkout_intent_id,
      provider_row.checkout_intent_id),
    plan_key = 'PROFESSIONAL', status = 'ACTIVE',
    current_period_start = COALESCE((input->>'periodStart')::TIMESTAMPTZ,
      current_period_start, occurred_at),
    current_period_end = COALESCE((input->>'periodEnd')::TIMESTAMPTZ,
      current_period_end, occurred_at + interval '1 month'),
    cancel_at_period_end = COALESCE((input->>'cancelAtPeriodEnd')::BOOLEAN, false),
    provider_event_at = occurred_at, updated_at = now()
  WHERE id = subscription_row.id
    AND (provider_event_at IS NULL OR provider_event_at <= occurred_at);
  PERFORM authenti8_ensure_allowance(org);
  RETURN jsonb_build_object('applied', true);
END $$;

REVOKE ALL ON FUNCTION authenti8_billing_subscription_context(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_billing_subscription_context(JSONB) TO service_role;

INSERT INTO schema_migrations(version) VALUES ('020_billing_provider_routing');
COMMIT;
