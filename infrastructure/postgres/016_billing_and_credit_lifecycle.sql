BEGIN;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT false;

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

CREATE OR REPLACE FUNCTION authenti8_complete_checkout_intent(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE billing_checkout_sessions checkout SET provider_session_id = input->>'sessionId',
    status = 'COMPLETED', updated_at = now() FROM organization_members member
  WHERE checkout.id = (input->>'checkoutIntentId')::UUID AND checkout.status = 'PENDING'
    AND member.organization_id = checkout.organization_id
    AND member.user_id = (input->>'userId')::UUID AND member.role IN ('OWNER', 'ADMIN')
  RETURNING jsonb_build_object('completed', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_fail_checkout_intent(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE billing_checkout_sessions checkout SET status = 'FAILED', updated_at = now()
  FROM organization_members member WHERE checkout.id = (input->>'checkoutIntentId')::UUID
    AND checkout.status IN ('PENDING', 'COMPLETED')
    AND member.organization_id = checkout.organization_id
    AND member.user_id = (input->>'userId')::UUID AND member.role IN ('OWNER', 'ADMIN')
  RETURNING jsonb_build_object('failed', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_apply_billing_event(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID := (input->>'organizationId')::UUID;
  billing_purpose TEXT := input->>'purpose';
  occurred_at TIMESTAMPTZ := COALESCE((input->>'occurredAt')::TIMESTAMPTZ, now());
  inserted INTEGER; authorized_intent billing_checkout_sessions;
  subscription_updated INTEGER := 0; known_subscription BOOLEAN := false;
BEGIN
  INSERT INTO billing_webhook_events(provider, event_id, event_type, payload)
  VALUES ('DODO', input->>'eventId', input->>'eventType', input)
  ON CONFLICT DO NOTHING; GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN RETURN jsonb_build_object('duplicate', true); END IF;
  SELECT checkout.* INTO authorized_intent FROM billing_checkout_sessions checkout
  WHERE checkout.organization_id = org AND checkout.purpose = billing_purpose
    AND checkout.quantity = (input->>'quantity')::INTEGER
    AND checkout.status IN ('PENDING', 'COMPLETED')
    AND ((COALESCE(input->>'checkoutIntentId', '') <> ''
      AND checkout.id = (input->>'checkoutIntentId')::UUID)
      OR (COALESCE(input->>'checkoutSessionId', '') <> ''
        AND checkout.provider_session_id = input->>'checkoutSessionId'))
  ORDER BY checkout.created_at DESC LIMIT 1;
  IF billing_purpose = 'PROFESSIONAL' AND COALESCE(input->>'subscriptionId', '') <> '' THEN
    SELECT EXISTS(SELECT 1 FROM subscriptions subscription
      WHERE subscription.organization_id = org
        AND subscription.provider_subscription_id = input->>'subscriptionId')
    INTO known_subscription;
  END IF;
  IF authorized_intent.id IS NULL AND NOT known_subscription THEN
    RETURN jsonb_build_object('ignored', true, 'reason', 'UNAUTHORIZED_CHECKOUT');
  END IF;
  IF COALESCE(input->>'paymentId', '') <> '' THEN
    INSERT INTO billing_provider_payments(payment_id, organization_id,
      provider_subscription_id, checkout_intent_id, purpose, quantity,
      amount_minor, currency, event_occurred_at)
    VALUES (input->>'paymentId', org, NULLIF(input->>'subscriptionId', ''),
      authorized_intent.id, billing_purpose, (input->>'quantity')::INTEGER,
      NULLIF(input->>'amountMinor', '')::BIGINT,
      NULLIF(input->>'currency', ''), occurred_at)
    ON CONFLICT (payment_id) DO UPDATE SET
      provider_subscription_id = COALESCE(EXCLUDED.provider_subscription_id,
        billing_provider_payments.provider_subscription_id),
      checkout_intent_id = COALESCE(EXCLUDED.checkout_intent_id,
        billing_provider_payments.checkout_intent_id),
      amount_minor = COALESCE(EXCLUDED.amount_minor, billing_provider_payments.amount_minor),
      currency = COALESCE(EXCLUDED.currency, billing_provider_payments.currency),
      event_occurred_at = GREATEST(EXCLUDED.event_occurred_at,
        billing_provider_payments.event_occurred_at), updated_at = now();
  END IF;
  UPDATE billing_checkout_sessions SET status = 'COMPLETED', updated_at = now()
  WHERE organization_id = org AND (provider_session_id = input->>'checkoutSessionId'
    OR id = authorized_intent.id) AND status IN ('PENDING', 'COMPLETED');
  IF input->>'eventType' IN ('payment.succeeded', 'payment.completed')
    AND billing_purpose = 'PROFESSIONAL' THEN
    RETURN jsonb_build_object('applied', true, 'paymentMapped', true);
  END IF;
  IF billing_purpose = 'PROFESSIONAL' AND input->>'eventType' IN
    ('subscription.cancelled', 'subscription.expired') THEN
    UPDATE subscriptions SET plan_key = 'STARTER', status = 'ACTIVE',
      provider_subscription_id = NULL, current_period_start = NULL,
      current_period_end = NULL, provider_checkout_intent_id = NULL,
      cancel_at_period_end = false,
      provider_event_at = occurred_at, updated_at = now()
    WHERE organization_id = org AND provider_subscription_id = input->>'subscriptionId'
      AND (provider_event_at IS NULL OR provider_event_at <= occurred_at);
    PERFORM authenti8_ensure_allowance(org);
  ELSIF billing_purpose = 'PROFESSIONAL' AND input->>'eventType' IN
    ('subscription.failed', 'subscription.on_hold', 'subscription.paused') THEN
    IF input->>'eventType' = 'subscription.failed' AND authorized_intent.id IS NOT NULL THEN
      UPDATE billing_checkout_sessions SET status = 'FAILED', updated_at = now()
      WHERE id = authorized_intent.id;
    END IF;
    UPDATE subscriptions SET status = 'PAST_DUE', current_period_start =
      COALESCE((input->>'periodStart')::TIMESTAMPTZ, current_period_start),
      current_period_end = COALESCE((input->>'periodEnd')::TIMESTAMPTZ, current_period_end),
      cancel_at_period_end = COALESCE((input->>'cancelAtPeriodEnd')::BOOLEAN,
        cancel_at_period_end), provider_event_at = occurred_at, updated_at = now()
    WHERE organization_id = org AND provider_subscription_id = input->>'subscriptionId'
      AND (provider_event_at IS NULL OR provider_event_at <= occurred_at);
  ELSIF billing_purpose = 'PROFESSIONAL' THEN
    UPDATE subscriptions SET provider = 'DODO', provider_subscription_id = input->>'subscriptionId',
      provider_checkout_intent_id = CASE
        WHEN provider_subscription_id IS DISTINCT FROM NULLIF(input->>'subscriptionId', '')
          THEN authorized_intent.id
        ELSE COALESCE(provider_checkout_intent_id, authorized_intent.id) END,
      plan_key = 'PROFESSIONAL', status = 'ACTIVE',
      current_period_start = COALESCE((input->>'periodStart')::TIMESTAMPTZ, now()),
      current_period_end = COALESCE((input->>'periodEnd')::TIMESTAMPTZ,
        now() + interval '1 month'),
      cancel_at_period_end = COALESCE((input->>'cancelAtPeriodEnd')::BOOLEAN,
        cancel_at_period_end), provider_event_at = occurred_at, updated_at = now()
    WHERE organization_id = org AND (provider_subscription_id = NULLIF(input->>'subscriptionId', '')
      OR (authorized_intent.id IS NOT NULL AND (provider_subscription_id IS NULL
        OR (status = 'PAST_DUE' AND (provider_checkout_intent_id IS NULL
          OR authorized_intent.created_at > (SELECT previous.created_at
            FROM billing_checkout_sessions previous WHERE previous.id = provider_checkout_intent_id))))))
      AND (provider_event_at IS NULL OR provider_event_at <= occurred_at);
    GET DIAGNOSTICS subscription_updated = ROW_COUNT;
    IF subscription_updated = 1 AND authorized_intent.id IS NOT NULL
      AND NULLIF(input->>'subscriptionId', '') IS NOT NULL THEN
      UPDATE billing_checkout_sessions SET status = 'ACTIVATED', updated_at = now()
      WHERE id = authorized_intent.id;
    END IF;
    PERFORM authenti8_ensure_allowance(org);
  ELSIF billing_purpose = 'EXTRA_CREDITS' THEN
    INSERT INTO credit_transactions(organization_id, amount, kind, reference_id, idempotency_key)
    VALUES (org, (input->>'quantity')::INTEGER, 'EXTRA_PURCHASE', input->>'paymentId',
      'dodo:' || (input->>'eventId')) ON CONFLICT DO NOTHING;
    UPDATE billing_checkout_sessions SET status = 'ACTIVATED', updated_at = now()
    WHERE id = authorized_intent.id;
  END IF;
  RETURN jsonb_build_object('applied', true);
END $$;

CREATE OR REPLACE FUNCTION authenti8_apply_dunning_recovery(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE subscription_row subscriptions; inserted INTEGER;
  occurred_at TIMESTAMPTZ := COALESCE((input->>'occurredAt')::TIMESTAMPTZ, now());
BEGIN
  SELECT * INTO subscription_row FROM subscriptions
  WHERE provider = 'DODO' AND provider_subscription_id = input->>'subscriptionId'
  FOR UPDATE;
  IF subscription_row.id IS NULL THEN
    RETURN jsonb_build_object('ignored', true, 'reason', 'UNKNOWN_SUBSCRIPTION');
  END IF;
  INSERT INTO billing_webhook_events(provider, event_id, event_type, payload)
  VALUES ('DODO', input->>'eventId', 'dunning.recovered', input)
  ON CONFLICT DO NOTHING; GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN RETURN jsonb_build_object('duplicate', true); END IF;
  IF COALESCE(input->>'paymentId', '') <> '' THEN
    INSERT INTO billing_provider_payments(payment_id, organization_id,
      provider_subscription_id, checkout_intent_id, purpose, quantity, event_occurred_at)
    VALUES (input->>'paymentId', subscription_row.organization_id,
      input->>'subscriptionId', subscription_row.provider_checkout_intent_id,
      'PROFESSIONAL', 1, occurred_at)
    ON CONFLICT (payment_id) DO UPDATE SET
      provider_subscription_id = EXCLUDED.provider_subscription_id,
      checkout_intent_id = COALESCE(EXCLUDED.checkout_intent_id,
        billing_provider_payments.checkout_intent_id),
      event_occurred_at = GREATEST(EXCLUDED.event_occurred_at,
        billing_provider_payments.event_occurred_at), updated_at = now();
  END IF;
  UPDATE subscriptions SET plan_key = 'PROFESSIONAL', status = 'ACTIVE',
    current_period_start = COALESCE((input->>'periodStart')::TIMESTAMPTZ,
      current_period_start, occurred_at),
    current_period_end = COALESCE((input->>'periodEnd')::TIMESTAMPTZ,
      current_period_end, occurred_at + interval '1 month'),
    cancel_at_period_end = COALESCE((input->>'cancelAtPeriodEnd')::BOOLEAN, false),
    provider_event_at = occurred_at, updated_at = now()
  WHERE id = subscription_row.id
    AND (provider_event_at IS NULL OR provider_event_at <= occurred_at);
  PERFORM authenti8_ensure_allowance(subscription_row.organization_id);
  RETURN jsonb_build_object('applied', true);
END $$;

CREATE OR REPLACE FUNCTION authenti8_reconcile_entitlement(org_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE subscription_status TEXT; entitlement INTEGER := 0; candidate RECORD;
BEGIN
  PERFORM id FROM organizations WHERE id = org_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT status INTO subscription_status FROM subscriptions
  WHERE organization_id = org_id ORDER BY updated_at DESC LIMIT 1;
  IF subscription_status IN ('ACTIVE', 'TRIALING') THEN
    PERFORM authenti8_ensure_allowance(org_id);
    entitlement := GREATEST(authenti8_ledger_balance(org_id), 0);
  END IF;
  WITH desired AS (
    SELECT interview.id FROM interviews interview
    WHERE interview.organization_id = org_id AND interview.status = 'DETECTED'
      AND interview.scheduled_end > now()
    ORDER BY interview.scheduled_start, interview.id LIMIT entitlement
  )
  UPDATE credit_reservations reservation SET status = 'RELEASED', released_at = now(),
    release_reason = 'ENTITLEMENT'
  WHERE reservation.organization_id = org_id AND reservation.status = 'RESERVED'
    AND NOT EXISTS (SELECT 1 FROM desired WHERE desired.id = reservation.interview_id);
  FOR candidate IN
    SELECT interview.id FROM interviews interview
    LEFT JOIN credit_reservations reservation ON reservation.interview_id = interview.id
    WHERE interview.organization_id = org_id AND interview.status = 'DETECTED'
      AND interview.scheduled_end > now()
      AND (reservation.id IS NULL OR (reservation.status = 'RELEASED'
        AND reservation.release_reason IN ('ENTITLEMENT', 'INELIGIBLE')))
    ORDER BY interview.scheduled_start, interview.id LIMIT entitlement
  LOOP
    EXIT WHEN authenti8_available_credits(org_id) <= 0;
    PERFORM authenti8_reserve_credit(jsonb_build_object('interviewId', candidate.id));
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION authenti8_reconcile_user_credits(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID;
BEGIN
  org := authenti8_user_organization((input->>'userId')::UUID);
  IF org IS NULL THEN RETURN NULL; END IF;
  PERFORM authenti8_reconcile_entitlement(org);
  RETURN jsonb_build_object('reconciled', true);
END $$;

CREATE OR REPLACE FUNCTION authenti8_interview_credit_trigger() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'DETECTED' AND NEW.scheduled_end > now() THEN
    IF NOT EXISTS (SELECT 1 FROM credit_reservations
      WHERE interview_id = NEW.id AND status = 'RELEASED' AND release_reason = 'MANUAL') THEN
      PERFORM authenti8_reserve_credit(jsonb_build_object('interviewId', NEW.id));
    END IF;
  ELSIF NEW.status = 'DETECTED'
    OR NEW.status IN ('CANCELLED', 'EXCLUDED', 'SYNC_FAILED') THEN
    UPDATE credit_reservations SET status = 'RELEASED', released_at = now(),
      release_reason = 'INELIGIBLE'
    WHERE interview_id = NEW.id AND status = 'RESERVED';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION authenti8_reconcile_user_credits(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_reconcile_user_credits(JSONB) TO service_role;
REVOKE ALL ON FUNCTION authenti8_apply_dunning_recovery(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_apply_dunning_recovery(JSONB) TO service_role;

SELECT authenti8_reconcile_all_credits('{}'::JSONB);
INSERT INTO schema_migrations(version) VALUES ('016_billing_and_credit_lifecycle');
COMMIT;
