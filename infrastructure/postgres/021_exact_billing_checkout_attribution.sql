BEGIN;

ALTER TABLE billing_provider_payments
  ADD COLUMN IF NOT EXISTS checkout_intent_id UUID
  REFERENCES billing_checkout_sessions(id) ON DELETE SET NULL;

-- Repair rows written before exact checkout attribution was installed. The
-- persisted webhook envelope is the authoritative source; subscriptions may
-- already contain the incorrect "newest checkout" value from the old trigger.
WITH exact_payment_checkout AS (
  SELECT DISTINCT ON (payment.payment_id)
    payment.payment_id, checkout.id AS checkout_intent_id
  FROM billing_provider_payments payment
  JOIN billing_webhook_events event
    ON event.provider = 'DODO'
    AND event.payload->>'paymentId' = payment.payment_id
  JOIN billing_checkout_sessions checkout
    ON checkout.organization_id = payment.organization_id
    AND (checkout.id = CASE
        WHEN event.payload->>'checkoutIntentId' ~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN (event.payload->>'checkoutIntentId')::UUID END
      OR checkout.provider_session_id = NULLIF(event.payload->>'checkoutSessionId', ''))
  ORDER BY payment.payment_id, event.processed_at DESC
)
UPDATE billing_provider_payments payment
SET checkout_intent_id = exact.checkout_intent_id, updated_at = now()
FROM exact_payment_checkout exact
WHERE payment.payment_id = exact.payment_id
  AND payment.checkout_intent_id IS DISTINCT FROM exact.checkout_intent_id;

-- The first attributable payment is the subscription's authorized checkout.
-- Later renewal payments inherit that binding and must not replace it.
WITH exact_subscription_checkout AS (
  SELECT DISTINCT ON (payment.provider_subscription_id)
    payment.provider_subscription_id, payment.organization_id,
    payment.checkout_intent_id
  FROM billing_provider_payments payment
  WHERE payment.provider_subscription_id IS NOT NULL
    AND payment.purpose = 'PROFESSIONAL'
    AND payment.checkout_intent_id IS NOT NULL
  ORDER BY payment.provider_subscription_id, payment.event_occurred_at,
    payment.created_at, payment.payment_id
)
INSERT INTO billing_provider_subscriptions(
  provider_subscription_id, organization_id, checkout_intent_id)
SELECT provider_subscription_id, organization_id, checkout_intent_id
FROM exact_subscription_checkout
ON CONFLICT (provider_subscription_id) DO UPDATE SET
  organization_id = EXCLUDED.organization_id,
  checkout_intent_id = EXCLUDED.checkout_intent_id,
  updated_at = now();

UPDATE subscriptions subscription
SET provider_checkout_intent_id = mapping.checkout_intent_id, updated_at = now()
FROM billing_provider_subscriptions mapping
WHERE subscription.provider_subscription_id = mapping.provider_subscription_id
  AND subscription.organization_id = mapping.organization_id
  AND mapping.checkout_intent_id IS NOT NULL
  AND subscription.provider_checkout_intent_id IS DISTINCT FROM mapping.checkout_intent_id;

CREATE OR REPLACE FUNCTION authenti8_bind_payment_checkout() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.checkout_intent_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT checkout.id INTO NEW.checkout_intent_id
  FROM billing_webhook_events event
  JOIN billing_checkout_sessions checkout
    ON checkout.organization_id = NEW.organization_id
    AND ((checkout.id = CASE
        WHEN event.payload->>'checkoutIntentId' ~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN (event.payload->>'checkoutIntentId')::UUID END)
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

DROP TRIGGER IF EXISTS authenti8_track_provider_payment_subscription_trigger
  ON billing_provider_payments;
CREATE TRIGGER authenti8_track_provider_payment_subscription_trigger
AFTER INSERT OR UPDATE OF provider_subscription_id ON billing_provider_payments
FOR EACH ROW EXECUTE FUNCTION authenti8_track_provider_payment_subscription();

-- A Dodo session is marked COMPLETED when it is created, not when it is paid.
-- Reconciliation runs immediately before another Professional checkout. If a
-- provider session is still payable, reuse its idempotency key so the customer
-- receives that checkout again without invalidating its webhook authorization.
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
  IF input->>'purpose' = 'PROFESSIONAL' AND subscription_status IN ('ACTIVE', 'TRIALING')
    AND subscription_plan = 'PROFESSIONAL' THEN
    RETURN jsonb_build_object('reason', 'ACTIVE_PLAN');
  END IF;
  IF input->>'purpose' = 'PROFESSIONAL' AND subscription_status = 'PAST_DUE'
    AND provider_subscription IS NOT NULL THEN
    RETURN jsonb_build_object('reason', 'EXISTING_SUBSCRIPTION');
  END IF;
  IF input->>'purpose' = 'PROFESSIONAL' THEN
    UPDATE billing_checkout_sessions SET status = 'FAILED', updated_at = now()
    WHERE organization_id = org AND purpose = 'PROFESSIONAL'
      AND status = 'PENDING' AND created_at <= now() - interval '30 minutes';
    SELECT * INTO intent FROM billing_checkout_sessions
    WHERE organization_id = org AND purpose = 'PROFESSIONAL' AND status = 'PENDING'
    ORDER BY created_at DESC LIMIT 1;
    IF intent.id IS NOT NULL THEN RETURN jsonb_build_object('organizationId', org,
      'email', account_email, 'checkoutIntentId', intent.id, 'reused', true); END IF;
    SELECT * INTO intent FROM billing_checkout_sessions
    WHERE organization_id = org AND purpose = 'PROFESSIONAL' AND status = 'COMPLETED'
    ORDER BY updated_at DESC LIMIT 1;
    IF intent.id IS NOT NULL THEN
      -- Give the completion write and an arriving webhook a brief window to
      -- converge, then let an abandoned provider checkout resume immediately.
      IF intent.updated_at > now() - interval '5 seconds' THEN
        RETURN jsonb_build_object('reason', 'ACTIVATION_PENDING');
      END IF;
      RETURN jsonb_build_object('organizationId', org, 'email', account_email,
        'checkoutIntentId', intent.id, 'reused', true);
    END IF;
  END IF;
  INSERT INTO billing_checkout_sessions(organization_id, provider, provider_session_id,
    purpose, quantity) VALUES (org, 'DODO', 'intent:' || gen_random_uuid(),
    input->>'purpose', COALESCE((input->>'quantity')::INTEGER, 1)) RETURNING * INTO intent;
  RETURN jsonb_build_object('organizationId', org, 'email', account_email,
    'checkoutIntentId', intent.id);
END $$;

INSERT INTO schema_migrations(version)
VALUES ('021_exact_billing_checkout_attribution');
COMMIT;
