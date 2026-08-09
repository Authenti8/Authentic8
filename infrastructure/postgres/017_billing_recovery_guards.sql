BEGIN;

CREATE TABLE billing_provider_subscriptions (
  provider_subscription_id TEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE billing_provider_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_provider_subscriptions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_provider_subscriptions FROM PUBLIC, anon, authenticated;

INSERT INTO billing_provider_subscriptions(provider_subscription_id, organization_id)
SELECT provider_subscription_id, organization_id FROM subscriptions
WHERE provider_subscription_id IS NOT NULL
ON CONFLICT (provider_subscription_id) DO NOTHING;

INSERT INTO billing_provider_subscriptions(provider_subscription_id, organization_id)
SELECT DISTINCT ON (provider_subscription_id) provider_subscription_id, organization_id
FROM billing_provider_payments WHERE provider_subscription_id IS NOT NULL
ORDER BY provider_subscription_id, updated_at DESC
ON CONFLICT (provider_subscription_id) DO NOTHING;

CREATE OR REPLACE FUNCTION authenti8_track_provider_subscription() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE provider_id TEXT;
BEGIN
  provider_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.provider_subscription_id
    ELSE COALESCE(NEW.provider_subscription_id, OLD.provider_subscription_id) END;
  IF provider_id IS NOT NULL THEN
    INSERT INTO billing_provider_subscriptions(provider_subscription_id, organization_id)
    VALUES (provider_id, NEW.organization_id)
    ON CONFLICT (provider_subscription_id) DO UPDATE SET
      organization_id = EXCLUDED.organization_id, updated_at = now();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS authenti8_track_provider_subscription_trigger ON subscriptions;
CREATE TRIGGER authenti8_track_provider_subscription_trigger
AFTER INSERT OR UPDATE OF provider_subscription_id ON subscriptions
FOR EACH ROW EXECUTE FUNCTION authenti8_track_provider_subscription();

CREATE OR REPLACE FUNCTION authenti8_complete_checkout_intent(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE billing_checkout_sessions checkout SET provider_session_id = input->>'sessionId',
    status = 'COMPLETED', updated_at = now() FROM organization_members member
  WHERE checkout.id = (input->>'checkoutIntentId')::UUID AND checkout.status = 'PENDING'
    AND member.organization_id = checkout.organization_id
    AND member.user_id = (input->>'userId')::UUID AND member.role IN ('OWNER', 'ADMIN')
  RETURNING jsonb_build_object('completed', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_billing_summary(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID; plan TEXT; state TEXT; allowance INTEGER; balance INTEGER; used INTEGER;
  scheduled_cancel BOOLEAN;
BEGIN
  org := authenti8_user_organization((input->>'userId')::UUID);
  IF org IS NULL THEN RETURN NULL; END IF;
  PERFORM authenti8_ensure_allowance(org);
  SELECT plan_key, status, cancel_at_period_end INTO plan, state, scheduled_cancel
  FROM subscriptions WHERE organization_id = org ORDER BY updated_at DESC LIMIT 1;
  plan := COALESCE(plan, 'STARTER');
  balance := CASE WHEN COALESCE(state, 'ACTIVE') IN ('ACTIVE', 'TRIALING')
    THEN authenti8_available_credits(org) ELSE 0 END;
  SELECT COALESCE(-sum(amount) FILTER (WHERE kind IN
    ('ALLOWANCE_CONSUMED', 'EXTRA_CONSUMED')), 0)
  INTO used FROM credit_transactions WHERE organization_id = org
    AND created_at >= authenti8_period_start(org);
  allowance := authenti8_allowance(plan);
  RETURN jsonb_build_object('plan', plan, 'status', COALESCE(state, 'ACTIVE'),
    'allowance', allowance, 'balance', balance, 'used', used,
    'periodStart', authenti8_period_start(org), 'periodEnd', authenti8_period_end(org),
    'cancelAtPeriodEnd', COALESCE(scheduled_cancel, false));
END $$;

CREATE OR REPLACE FUNCTION authenti8_apply_dunning_recovery(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID; subscription_row subscriptions; inserted INTEGER;
  occurred_at TIMESTAMPTZ := COALESCE((input->>'occurredAt')::TIMESTAMPTZ, now());
BEGIN
  SELECT organization_id INTO org FROM billing_provider_subscriptions
  WHERE provider_subscription_id = input->>'subscriptionId';
  IF org IS NULL THEN
    RETURN jsonb_build_object('ignored', true, 'reason', 'UNKNOWN_SUBSCRIPTION');
  END IF;
  SELECT * INTO subscription_row FROM subscriptions WHERE organization_id = org FOR UPDATE;
  IF subscription_row.provider_subscription_id IS NOT NULL
    AND subscription_row.provider_subscription_id <> input->>'subscriptionId' THEN
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
      subscription_row.provider_checkout_intent_id, 'PROFESSIONAL', 1, occurred_at)
    ON CONFLICT (payment_id) DO UPDATE SET
      provider_subscription_id = EXCLUDED.provider_subscription_id,
      checkout_intent_id = COALESCE(EXCLUDED.checkout_intent_id,
        billing_provider_payments.checkout_intent_id),
      event_occurred_at = GREATEST(EXCLUDED.event_occurred_at,
        billing_provider_payments.event_occurred_at), updated_at = now();
  END IF;
  UPDATE subscriptions SET provider = 'DODO',
    provider_subscription_id = input->>'subscriptionId',
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

REVOKE ALL ON FUNCTION authenti8_complete_checkout_intent(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_complete_checkout_intent(JSONB) TO service_role;
REVOKE ALL ON FUNCTION authenti8_billing_summary(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_billing_summary(JSONB) TO service_role;
REVOKE ALL ON FUNCTION authenti8_apply_dunning_recovery(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_apply_dunning_recovery(JSONB) TO service_role;

INSERT INTO schema_migrations(version) VALUES ('017_billing_recovery_guards');
COMMIT;
