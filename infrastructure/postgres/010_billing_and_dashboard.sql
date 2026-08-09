BEGIN;
CREATE TABLE billing_webhook_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
CREATE TABLE billing_checkout_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_session_id TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('PROFESSIONAL', 'EXTRA_CREDITS')),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE billing_provider_payments (
  payment_id TEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider_subscription_id TEXT, checkout_intent_id UUID REFERENCES billing_checkout_sessions(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('PROFESSIONAL', 'EXTRA_CREDITS')),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 1000),
  amount_minor BIGINT,
  currency TEXT,
  reversed_amount_minor BIGINT NOT NULL DEFAULT 0,
  event_occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE subscriptions
  ADD COLUMN provider_event_at TIMESTAMPTZ,
  ADD COLUMN cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN provider_checkout_intent_id UUID
    REFERENCES billing_checkout_sessions(id) ON DELETE SET NULL;
CREATE TABLE credit_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  interview_id UUID NOT NULL UNIQUE REFERENCES interviews(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'RESERVED'
    CHECK (status IN ('RESERVED', 'CONSUMED', 'RELEASED')),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  release_reason TEXT CHECK (release_reason IN ('ENTITLEMENT', 'INELIGIBLE', 'MANUAL'))
);
ALTER TABLE billing_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_checkout_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_provider_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_reservations ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION authenti8_user_organization(user_id UUID) RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT organization_id FROM organization_members
  WHERE organization_members.user_id = authenti8_user_organization.user_id
  ORDER BY created_at LIMIT 1
$$;
CREATE OR REPLACE FUNCTION authenti8_period_start(org_id UUID) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE WHEN plan_key = 'PROFESSIONAL' AND current_period_start IS NOT NULL
    THEN current_period_start ELSE date_trunc('month', now()) END
  FROM subscriptions WHERE organization_id = org_id ORDER BY updated_at DESC LIMIT 1
$$;
CREATE OR REPLACE FUNCTION authenti8_period_end(org_id UUID) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE WHEN plan_key = 'PROFESSIONAL' AND current_period_end IS NOT NULL
    THEN current_period_end ELSE date_trunc('month', now()) + interval '1 month' END
  FROM subscriptions WHERE organization_id = org_id ORDER BY updated_at DESC LIMIT 1
$$;
CREATE OR REPLACE FUNCTION authenti8_period_key(org_id UUID) RETURNS TEXT
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE WHEN plan_key = 'PROFESSIONAL' AND current_period_start IS NOT NULL
    THEN current_period_start::TEXT ELSE to_char(date_trunc('month', now()), 'YYYY-MM') END
  FROM subscriptions WHERE organization_id = org_id ORDER BY updated_at DESC LIMIT 1
$$;
CREATE OR REPLACE FUNCTION authenti8_allowance(plan TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE plan WHEN 'PROFESSIONAL' THEN 300 WHEN 'ENTERPRISE' THEN 0 ELSE 10 END
$$;
CREATE OR REPLACE FUNCTION authenti8_ensure_allowance(organization_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE current_plan TEXT; current_status TEXT; allowance INTEGER; period_key TEXT;
BEGIN
  SELECT plan_key, status INTO current_plan, current_status FROM subscriptions
  WHERE subscriptions.organization_id = authenti8_ensure_allowance.organization_id
  ORDER BY updated_at DESC LIMIT 1 FOR UPDATE;
  current_plan := COALESCE(current_plan, 'STARTER');
  IF current_status NOT IN ('ACTIVE', 'TRIALING') THEN RETURN; END IF;
  allowance := authenti8_allowance(current_plan);
  period_key := authenti8_period_key(organization_id);
  INSERT INTO credit_transactions(organization_id, amount, kind, reference_id, idempotency_key)
  VALUES (organization_id, allowance, 'MONTHLY_ALLOWANCE', period_key,
    'allowance:' || organization_id || ':' || period_key)
  ON CONFLICT (idempotency_key) DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION authenti8_ledger_balance(org_id UUID) RETURNS INTEGER
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(sum(amount) FILTER (WHERE
    (kind IN ('MONTHLY_ALLOWANCE', 'PLAN_UPGRADE', 'ALLOWANCE_CONSUMED')
      AND reference_id = authenti8_period_key(org_id))
    OR kind IN ('EXTRA_PURCHASE', 'EXTRA_CONSUMED', 'EXTRA_REVERSAL')), 0)::INTEGER
  FROM credit_transactions WHERE organization_id = org_id
$$;
CREATE OR REPLACE FUNCTION authenti8_available_credits(org_id UUID) RETURNS INTEGER
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT GREATEST(authenti8_ledger_balance(org_id) - count(*)::INTEGER, 0)
  FROM credit_reservations WHERE organization_id = org_id AND status = 'RESERVED'
$$;
CREATE OR REPLACE FUNCTION authenti8_billing_summary(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID; plan TEXT; state TEXT; allowance INTEGER; balance INTEGER; used INTEGER;
  scheduled_cancel BOOLEAN;
BEGIN
  org := authenti8_user_organization((input->>'userId')::UUID);
  IF org IS NULL THEN RETURN NULL; END IF;
  PERFORM authenti8_ensure_allowance(org);
  SELECT plan_key, status, cancel_at_period_end INTO plan, state, scheduled_cancel FROM subscriptions
  WHERE organization_id = org ORDER BY updated_at DESC LIMIT 1;
  plan := COALESCE(plan, 'STARTER');
  balance := authenti8_available_credits(org);
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
CREATE OR REPLACE FUNCTION authenti8_record_checkout(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID; row_id UUID;
BEGIN
  org := authenti8_user_organization((input->>'userId')::UUID);
  IF org IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM organization_members WHERE organization_id = org
    AND user_id = (input->>'userId')::UUID AND role IN ('OWNER', 'ADMIN')) THEN RETURN NULL; END IF;
  INSERT INTO billing_checkout_sessions(
    organization_id, provider, provider_session_id, purpose, quantity
  ) VALUES (org, 'DODO', input->>'sessionId', input->>'purpose',
    COALESCE((input->>'quantity')::INTEGER, 1)) RETURNING id INTO row_id;
  RETURN jsonb_build_object('id', row_id, 'organizationId', org);
END $$;
CREATE OR REPLACE FUNCTION authenti8_begin_checkout(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID; account_email TEXT; intent billing_checkout_sessions;
  subscription_status TEXT;
BEGIN
  SELECT member.organization_id, account.email INTO org, account_email
  FROM organization_members member JOIN users account ON account.id = member.user_id
  WHERE member.user_id = (input->>'userId')::UUID AND member.role IN ('OWNER', 'ADMIN')
  ORDER BY member.created_at LIMIT 1;
  IF org IS NULL THEN RETURN NULL; END IF;
  PERFORM id FROM organizations WHERE id = org FOR UPDATE;
  SELECT status INTO subscription_status FROM subscriptions
  WHERE organization_id = org ORDER BY updated_at DESC LIMIT 1;
  IF input->>'purpose' = 'EXTRA_CREDITS'
    AND COALESCE(subscription_status, 'ACTIVE') NOT IN ('ACTIVE', 'TRIALING') THEN
    RETURN jsonb_build_object('reason', 'INACTIVE_SUBSCRIPTION');
  END IF;
  IF input->>'purpose' = 'PROFESSIONAL' AND EXISTS (
    SELECT 1 FROM subscriptions WHERE organization_id = org
      AND plan_key = 'PROFESSIONAL' AND status = 'ACTIVE'
  ) THEN RETURN jsonb_build_object('reason', 'ACTIVE_PLAN'); END IF;
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
CREATE OR REPLACE FUNCTION authenti8_checkout_context(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('organizationId', member.organization_id, 'email', account.email)
  FROM organization_members member JOIN users account ON account.id = member.user_id
  WHERE member.user_id = (input->>'userId')::UUID AND member.role IN ('OWNER', 'ADMIN')
  ORDER BY member.created_at LIMIT 1
$$;
CREATE OR REPLACE FUNCTION authenti8_apply_billing_event(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID := (input->>'organizationId')::UUID;
  billing_purpose TEXT := input->>'purpose';
  occurred_at TIMESTAMPTZ := COALESCE((input->>'occurredAt')::TIMESTAMPTZ, now()); inserted INTEGER;
  authorized_intent billing_checkout_sessions; subscription_updated INTEGER := 0;
  known_subscription BOOLEAN := false;
BEGIN
  INSERT INTO billing_webhook_events(provider, event_id, event_type, payload)
  VALUES ('DODO', input->>'eventId', input->>'eventType', input)
  ON CONFLICT DO NOTHING; GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN RETURN jsonb_build_object('duplicate', true); END IF;
  SELECT checkout.* INTO authorized_intent FROM billing_checkout_sessions checkout
  WHERE checkout.organization_id = org AND checkout.purpose = billing_purpose
    AND checkout.quantity = (input->>'quantity')::INTEGER
    AND checkout.status IN ('PENDING', 'COMPLETED')
    AND (
      (COALESCE(input->>'checkoutIntentId', '') <> ''
        AND checkout.id = (input->>'checkoutIntentId')::UUID)
      OR (COALESCE(input->>'checkoutSessionId', '') <> ''
        AND checkout.provider_session_id = input->>'checkoutSessionId')
    ) ORDER BY checkout.created_at DESC LIMIT 1;
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
      provider_subscription_id, purpose, quantity, amount_minor, currency, event_occurred_at)
    VALUES (input->>'paymentId', org, NULLIF(input->>'subscriptionId', ''), billing_purpose,
      (input->>'quantity')::INTEGER, NULLIF(input->>'amountMinor', '')::BIGINT,
      NULLIF(input->>'currency', ''), occurred_at)
    ON CONFLICT (payment_id) DO UPDATE SET
      provider_subscription_id = COALESCE(EXCLUDED.provider_subscription_id,
        billing_provider_payments.provider_subscription_id),
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
      cancel_at_period_end = COALESCE((input->>'cancelAtPeriodEnd')::BOOLEAN, cancel_at_period_end),
      provider_event_at = occurred_at, updated_at = now()
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
      current_period_end = COALESCE((input->>'periodEnd')::TIMESTAMPTZ, now() + interval '1 month'),
      cancel_at_period_end = COALESCE((input->>'cancelAtPeriodEnd')::BOOLEAN, cancel_at_period_end),
      provider_event_at = occurred_at, updated_at = now() WHERE organization_id = org
      AND (
        provider_subscription_id = NULLIF(input->>'subscriptionId', '')
        OR (
          authorized_intent.id IS NOT NULL
          AND (
            provider_subscription_id IS NULL
            OR (
              status = 'PAST_DUE'
              AND (provider_checkout_intent_id IS NULL OR authorized_intent.created_at >
                (SELECT previous.created_at FROM billing_checkout_sessions previous
                  WHERE previous.id = provider_checkout_intent_id))
            )
          )
        )
      )
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
CREATE OR REPLACE FUNCTION authenti8_apply_billing_reversal(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE payment billing_provider_payments; already_reversed INTEGER; target_reversed INTEGER;
  credits_to_reverse INTEGER; reversal_amount BIGINT;
BEGIN
  SELECT * INTO payment FROM billing_provider_payments
  WHERE payment_id = input->>'paymentId' FOR UPDATE;
  IF payment.payment_id IS NULL THEN
    RAISE EXCEPTION 'Provider payment mapping not found for reversal'
      USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO billing_webhook_events(provider, event_id, event_type, payload)
  VALUES ('DODO', input->>'eventId', input->>'eventType', input)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('duplicate', true); END IF;
  reversal_amount := LEAST(payment.reversed_amount_minor + COALESCE(
    NULLIF(input->>'amountMinor', '')::BIGINT, payment.amount_minor, 0),
    COALESCE(payment.amount_minor, 0));
  IF payment.purpose = 'EXTRA_CREDITS' AND payment.amount_minor > 0 THEN
    SELECT COALESCE(-sum(amount), 0)::INTEGER INTO already_reversed
    FROM credit_transactions WHERE kind = 'EXTRA_REVERSAL'
      AND reference_id = payment.payment_id;
    target_reversed := LEAST(payment.quantity,
      CEIL((reversal_amount::NUMERIC * payment.quantity) / payment.amount_minor)::INTEGER);
    credits_to_reverse := GREATEST(target_reversed - already_reversed, 0);
    IF credits_to_reverse > 0 THEN
      INSERT INTO credit_transactions(organization_id, amount, kind, reference_id, idempotency_key)
      VALUES (payment.organization_id, -credits_to_reverse, 'EXTRA_REVERSAL', payment.payment_id,
        'dodo-reversal:' || (input->>'reversalId')) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  UPDATE billing_provider_payments SET reversed_amount_minor = reversal_amount,
    updated_at = now() WHERE payment_id = payment.payment_id;
  IF payment.purpose = 'PROFESSIONAL' AND (
    reversal_amount >= COALESCE(payment.amount_minor, 1)
    OR input->>'eventType' IN ('dispute.accepted', 'dispute.lost')
  ) THEN
    UPDATE subscriptions SET status = 'PAST_DUE',
      provider_event_at = COALESCE((input->>'occurredAt')::TIMESTAMPTZ, now()), updated_at = now()
    WHERE organization_id = payment.organization_id
      AND provider_subscription_id = payment.provider_subscription_id
      AND (provider_event_at IS NULL OR provider_event_at <=
        COALESCE((input->>'occurredAt')::TIMESTAMPTZ, now()));
  END IF;
  RETURN jsonb_build_object('applied', true);
END $$; CREATE OR REPLACE FUNCTION authenti8_reserve_credit(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID; balance INTEGER; reservation credit_reservations;
  interview_row interviews;
BEGIN
  SELECT interview.* INTO interview_row FROM interviews interview
  WHERE interview.id = (input->>'interviewId')::UUID FOR UPDATE;
  IF interview_row.id IS NULL THEN RETURN NULL; END IF;
  IF interview_row.status <> 'DETECTED' THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'INTERVIEW_NOT_ELIGIBLE');
  END IF;
  org := interview_row.organization_id;
  SELECT * INTO reservation FROM credit_reservations
  WHERE interview_id = interview_row.id AND organization_id = org FOR UPDATE;
  PERFORM id FROM organizations WHERE id = org FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM subscriptions WHERE organization_id = org
    AND status IN ('ACTIVE', 'TRIALING')) THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'INACTIVE_SUBSCRIPTION');
  END IF;
  PERFORM authenti8_ensure_allowance(org);
  IF reservation.status = 'RESERVED' THEN
    RETURN jsonb_build_object('reserved', true, 'reservationId', reservation.id);
  ELSIF reservation.status = 'CONSUMED' THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'ALREADY_CONSUMED');
  END IF;
  balance := authenti8_available_credits(org);
  IF balance <= 0 THEN RETURN jsonb_build_object('reserved', false, 'reason', 'NO_CREDITS'); END IF;
  IF reservation.id IS NULL THEN
    INSERT INTO credit_reservations(organization_id, interview_id)
    VALUES (org, (input->>'interviewId')::UUID) RETURNING * INTO reservation;
  ELSE
    UPDATE credit_reservations SET status = 'RESERVED', reserved_at = now(),
      consumed_at = NULL, released_at = NULL, release_reason = NULL
      WHERE id = reservation.id RETURNING * INTO reservation;
  END IF;
  RETURN jsonb_build_object('reserved', true, 'reservationId', reservation.id);
END $$;
CREATE OR REPLACE FUNCTION authenti8_consume_credit(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE reservation credit_reservations; interview_row interviews; period_key TEXT;
  allowance_balance INTEGER;
  extra_balance INTEGER; transaction_kind TEXT;
BEGIN
  SELECT interview.* INTO interview_row FROM interviews interview
  WHERE interview.id = (input->>'interviewId')::UUID FOR UPDATE;
  IF interview_row.id IS NULL THEN RETURN NULL; END IF;
  SELECT reservation_row.* INTO reservation FROM credit_reservations reservation_row
  WHERE reservation_row.interview_id = interview_row.id FOR UPDATE;
  IF reservation.id IS NULL THEN RETURN NULL; END IF;
  PERFORM id FROM organizations WHERE id = reservation.organization_id FOR UPDATE;
  IF reservation.status = 'CONSUMED' THEN RETURN jsonb_build_object('consumed', true); END IF;
  IF reservation.status = 'RELEASED' THEN
    RETURN jsonb_build_object('consumed', false, 'reason', 'RELEASED');
  END IF;
  IF interview_row.organization_id <> reservation.organization_id
    OR interview_row.status <> 'DETECTED' THEN
    RETURN jsonb_build_object('consumed', false, 'reason', 'INTERVIEW_NOT_ELIGIBLE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subscriptions subscription
    WHERE subscription.organization_id = reservation.organization_id
      AND subscription.status IN ('ACTIVE', 'TRIALING')) THEN
    RETURN jsonb_build_object('consumed', false, 'reason', 'INACTIVE_SUBSCRIPTION');
  END IF;
  period_key := authenti8_period_key(reservation.organization_id);
  SELECT COALESCE(sum(amount), 0) INTO allowance_balance FROM credit_transactions
  WHERE organization_id = reservation.organization_id
    AND kind IN ('MONTHLY_ALLOWANCE', 'PLAN_UPGRADE', 'ALLOWANCE_CONSUMED')
    AND reference_id = period_key;
  SELECT COALESCE(sum(amount), 0) INTO extra_balance FROM credit_transactions
  WHERE organization_id = reservation.organization_id
    AND kind IN ('EXTRA_PURCHASE', 'EXTRA_CONSUMED', 'EXTRA_REVERSAL');
  IF allowance_balance <= 0 AND extra_balance <= 0 THEN
    RETURN jsonb_build_object('consumed', false, 'reason', 'NO_CREDITS');
  END IF;
  UPDATE interviews SET monitoring_started_at = COALESCE(monitoring_started_at, now()),
    status = 'MONITORING_ACTIVE', updated_at = now() WHERE id = reservation.interview_id
      AND organization_id = reservation.organization_id AND status = 'DETECTED';
  transaction_kind := CASE WHEN allowance_balance > 0
    THEN 'ALLOWANCE_CONSUMED' ELSE 'EXTRA_CONSUMED' END;
  UPDATE credit_reservations SET status = 'CONSUMED', consumed_at = now()
  WHERE id = reservation.id AND status = 'RESERVED';
  INSERT INTO credit_transactions(organization_id, amount, kind, reference_id, idempotency_key)
  VALUES (reservation.organization_id, -1, transaction_kind,
    CASE WHEN transaction_kind = 'ALLOWANCE_CONSUMED' THEN period_key
      ELSE reservation.interview_id::TEXT END,
    'consume:' || reservation.interview_id) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('consumed', true);
END $$;
CREATE OR REPLACE FUNCTION authenti8_release_credit(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE credit_reservations reservation SET status = 'RELEASED', released_at = now(),
    release_reason = 'MANUAL'
  WHERE reservation.interview_id = (input->>'interviewId')::UUID
    AND reservation.status = 'RESERVED'
  RETURNING jsonb_build_object('released', true)
$$;
DO $$
DECLARE function_name TEXT;
BEGIN
  FOREACH function_name IN ARRAY ARRAY[
    'authenti8_billing_summary', 'authenti8_record_checkout', 'authenti8_checkout_context',
    'authenti8_begin_checkout', 'authenti8_complete_checkout_intent',
    'authenti8_fail_checkout_intent',
    'authenti8_apply_billing_event', 'authenti8_apply_billing_reversal',
    'authenti8_reserve_credit',
    'authenti8_consume_credit', 'authenti8_release_credit'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I(JSONB) FROM PUBLIC, anon, authenticated', function_name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I(JSONB) TO service_role', function_name);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION authenti8_user_organization(UUID) FROM PUBLIC, anon, authenticated; REVOKE ALL ON FUNCTION authenti8_period_start(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_period_end(UUID) FROM PUBLIC, anon, authenticated; REVOKE ALL ON FUNCTION authenti8_period_key(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_allowance(TEXT) FROM PUBLIC, anon, authenticated; REVOKE ALL ON FUNCTION authenti8_ensure_allowance(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_ledger_balance(UUID) FROM PUBLIC, anon, authenticated; REVOKE ALL ON FUNCTION authenti8_available_credits(UUID) FROM PUBLIC, anon, authenticated;
UPDATE subscriptions SET plan_key = 'STARTER', status = CASE
  WHEN status = 'TRIALING' THEN 'ACTIVE' ELSE status END
WHERE plan_key = 'PILOT';
INSERT INTO schema_migrations(version) VALUES ('010_billing_and_dashboard');
COMMIT;
