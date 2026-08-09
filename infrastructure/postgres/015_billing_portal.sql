BEGIN;

CREATE OR REPLACE FUNCTION authenti8_begin_checkout(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID; account_email TEXT; intent billing_checkout_sessions;
  subscription_status TEXT; provider_subscription TEXT;
BEGIN
  SELECT member.organization_id, account.email INTO org, account_email
  FROM organization_members member JOIN users account ON account.id = member.user_id
  WHERE member.user_id = (input->>'userId')::UUID AND member.role IN ('OWNER', 'ADMIN')
  ORDER BY member.created_at LIMIT 1;
  IF org IS NULL THEN RETURN NULL; END IF;
  PERFORM id FROM organizations WHERE id = org FOR UPDATE;
  SELECT status, provider_subscription_id INTO subscription_status, provider_subscription
  FROM subscriptions WHERE organization_id = org ORDER BY updated_at DESC LIMIT 1;
  IF input->>'purpose' = 'EXTRA_CREDITS'
    AND COALESCE(subscription_status, 'ACTIVE') NOT IN ('ACTIVE', 'TRIALING') THEN
    RETURN jsonb_build_object('reason', 'INACTIVE_SUBSCRIPTION');
  END IF;
  IF input->>'purpose' = 'PROFESSIONAL'
    AND subscription_status IN ('ACTIVE', 'TRIALING')
    AND EXISTS (SELECT 1 FROM subscriptions WHERE organization_id = org
      AND plan_key = 'PROFESSIONAL') THEN
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

CREATE OR REPLACE FUNCTION authenti8_billing_portal_context(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('subscriptionId', subscription.provider_subscription_id)
  FROM subscriptions subscription JOIN organization_members member
    ON member.organization_id = subscription.organization_id
  WHERE member.user_id = (input->>'userId')::UUID AND member.role IN ('OWNER', 'ADMIN')
    AND subscription.provider = 'DODO' AND subscription.plan_key = 'PROFESSIONAL'
    AND subscription.status IN ('ACTIVE', 'TRIALING', 'PAST_DUE')
    AND subscription.provider_subscription_id IS NOT NULL
  ORDER BY subscription.updated_at DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION authenti8_pending_checkout_context(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('organizationId', checkout.organization_id,
    'checkoutIntentId', checkout.id, 'sessionId', checkout.provider_session_id)
  FROM billing_checkout_sessions checkout JOIN organization_members member
    ON member.organization_id = checkout.organization_id
  WHERE member.user_id = (input->>'userId')::UUID AND member.role IN ('OWNER', 'ADMIN')
    AND checkout.provider = 'DODO' AND checkout.purpose = 'PROFESSIONAL'
    AND checkout.status = 'COMPLETED' AND checkout.provider_session_id NOT LIKE 'intent:%'
  ORDER BY checkout.updated_at DESC LIMIT 1
$$;

REVOKE ALL ON FUNCTION authenti8_billing_portal_context(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_billing_portal_context(JSONB) TO service_role;
REVOKE ALL ON FUNCTION authenti8_pending_checkout_context(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_pending_checkout_context(JSONB) TO service_role;

INSERT INTO schema_migrations(version) VALUES ('015_billing_portal');
COMMIT;
