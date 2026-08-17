BEGIN;

CREATE TABLE billing_permission_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  manager_user_id UUID NOT NULL REFERENCES users(id),
  permission_type TEXT NOT NULL CHECK (permission_type = 'BILLING_PURCHASE'),
  granted_by UUID NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ,
  per_purchase_limit_minor BIGINT CHECK (per_purchase_limit_minor > 0),
  monthly_limit_minor BIGINT CHECK (monthly_limit_minor > 0),
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES users(id),
  revocation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE UNIQUE INDEX billing_permission_grants_active_idx
  ON billing_permission_grants(organization_id, manager_user_id, permission_type)
  WHERE revoked_at IS NULL;
ALTER TABLE billing_permission_grants ENABLE ROW LEVEL SECURITY;

ALTER TABLE billing_checkout_sessions
  ADD COLUMN purchaser_user_id UUID REFERENCES users(id),
  ADD COLUMN approving_owner_user_id UUID REFERENCES users(id),
  ADD COLUMN billing_grant_id UUID REFERENCES billing_permission_grants(id),
  ADD COLUMN authorized_amount_minor BIGINT CHECK (authorized_amount_minor IS NULL
    OR authorized_amount_minor >= 0);

CREATE OR REPLACE FUNCTION authenti8_billing_access(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; member organization_members;
  grant_row billing_permission_grants; owner_id UUID; requested BIGINT;
  spent BIGINT;
BEGIN
  SELECT * INTO member FROM organization_members WHERE user_id = actor AND status = 'ACTIVE'
    ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF member.user_id IS NULL OR member.business_role = 'HR' THEN RETURN NULL; END IF;
  SELECT user_id INTO owner_id FROM organization_members WHERE organization_id = member.organization_id
    AND business_role = 'OWNER' AND status = 'ACTIVE' ORDER BY created_at LIMIT 1;
  IF member.business_role = 'OWNER' THEN RETURN jsonb_build_object('organizationId',
    member.organization_id, 'approvingOwnerUserId', actor); END IF;
  SELECT * INTO grant_row FROM billing_permission_grants WHERE organization_id = member.organization_id
    AND manager_user_id = actor AND permission_type = 'BILLING_PURCHASE' AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF grant_row.id IS NULL THEN RETURN NULL; END IF;
  requested := NULLIF(input->>'amountMinor','')::BIGINT;
  IF grant_row.per_purchase_limit_minor IS NOT NULL
      AND (requested IS NULL OR requested > grant_row.per_purchase_limit_minor) THEN RETURN NULL; END IF;
  IF grant_row.monthly_limit_minor IS NOT NULL THEN
    SELECT COALESCE(sum(authorized_amount_minor),0) INTO spent FROM billing_checkout_sessions
      WHERE organization_id = member.organization_id AND purchaser_user_id = actor
        AND status IN ('PENDING','COMPLETED','ACTIVATED')
        AND id IS DISTINCT FROM NULLIF(input->>'existingCheckoutIntentId','')::UUID
        AND created_at >= date_trunc('month', now());
    IF requested IS NULL OR spent + requested > grant_row.monthly_limit_minor THEN RETURN NULL; END IF;
  END IF;
  RETURN jsonb_build_object('organizationId', member.organization_id,
    'approvingOwnerUserId', grant_row.granted_by, 'billingGrantId', grant_row.id);
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION authenti8_manage_billing_grant(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; org UUID; manager UUID;
  existing billing_permission_grants; reason TEXT := trim(input->>'reason');
BEGIN
  SELECT organization_id INTO org FROM organization_members WHERE user_id = actor
    AND business_role = 'OWNER' AND status = 'ACTIVE' ORDER BY created_at LIMIT 1;
  SELECT member.user_id INTO manager FROM organization_members member WHERE
    member.organization_id = org AND member.user_id = (input->>'managerUserId')::UUID
    AND member.business_role = 'MANAGER' AND member.status = 'ACTIVE';
  IF org IS NULL OR manager IS NULL OR length(reason) NOT BETWEEN 10 AND 500 THEN
    RETURN jsonb_build_object('updated',false,'reason','NOT_AUTHORIZED'); END IF;
  SELECT * INTO existing FROM billing_permission_grants WHERE organization_id = org
    AND manager_user_id = manager AND permission_type = 'BILLING_PURCHASE'
    AND revoked_at IS NULL FOR UPDATE;
  IF COALESCE((input->>'revoke')::BOOLEAN,false) THEN
    IF existing.id IS NULL THEN RETURN jsonb_build_object('updated',false,'reason','GRANT_NOT_FOUND'); END IF;
    UPDATE billing_permission_grants SET revoked_at=now(), revoked_by=actor,
      revocation_reason=reason, updated_at=now() WHERE id=existing.id;
  ELSE
    IF existing.id IS NOT NULL THEN UPDATE billing_permission_grants SET
      expires_at=NULLIF(input->>'expiresAt','')::TIMESTAMPTZ,
      per_purchase_limit_minor=NULLIF(input->>'perPurchaseLimitMinor','')::BIGINT,
      monthly_limit_minor=NULLIF(input->>'monthlyLimitMinor','')::BIGINT,
      granted_by=actor, updated_at=now() WHERE id=existing.id;
    ELSE INSERT INTO billing_permission_grants(organization_id,manager_user_id,permission_type,
      granted_by,expires_at,per_purchase_limit_minor,monthly_limit_minor) VALUES
      (org,manager,'BILLING_PURCHASE',actor,NULLIF(input->>'expiresAt','')::TIMESTAMPTZ,
      NULLIF(input->>'perPurchaseLimitMinor','')::BIGINT,NULLIF(input->>'monthlyLimitMinor','')::BIGINT);
    END IF;
  END IF;
  INSERT INTO audit_logs(organization_id,actor_user_id,action,target_type,target_id,reason,
    previous_value,new_value) VALUES(org,actor,'BILLING_GRANT_UPDATED','organization_member',
    manager::TEXT,reason,CASE WHEN existing.id IS NULL THEN NULL ELSE jsonb_build_object(
      'grantId',existing.id,'revokedAt',existing.revoked_at) END,jsonb_build_object(
      'permission','BILLING_PURCHASE','revoked',COALESCE((input->>'revoke')::BOOLEAN,false)));
  RETURN jsonb_build_object('updated',true);
EXCEPTION WHEN check_violation OR invalid_text_representation THEN
  RETURN jsonb_build_object('updated',false,'reason','INVALID_GRANT');
END $$;

CREATE OR REPLACE FUNCTION authenti8_begin_checkout(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE access JSONB; org UUID; account_email TEXT; intent billing_checkout_sessions;
  subscription_status TEXT; subscription_plan TEXT; provider_subscription TEXT;
BEGIN
  SELECT checkout.* INTO intent FROM billing_checkout_sessions checkout
    JOIN organization_members member ON member.organization_id=checkout.organization_id
    WHERE member.user_id=(input->>'userId')::UUID AND member.status='ACTIVE'
      AND checkout.purchaser_user_id=member.user_id AND checkout.status='PENDING'
      AND checkout.purpose=input->>'purpose'
      AND checkout.quantity=COALESCE((input->>'quantity')::INTEGER,1)
      AND checkout.authorized_amount_minor IS NOT DISTINCT FROM
        NULLIF(input->>'amountMinor','')::BIGINT
    ORDER BY checkout.created_at DESC LIMIT 1 FOR UPDATE OF checkout;
  access:=authenti8_billing_access(input||jsonb_build_object(
    'existingCheckoutIntentId',intent.id)); org:=(access->>'organizationId')::UUID;
  IF org IS NULL THEN RETURN NULL; END IF;
  IF intent.id IS NOT NULL AND intent.organization_id<>org THEN intent:=NULL; END IF;
  SELECT email INTO account_email FROM users WHERE id=(input->>'userId')::UUID AND status='ACTIVE';
  PERFORM id FROM organizations WHERE id=org FOR UPDATE;
  SELECT status,plan_key,provider_subscription_id INTO subscription_status,subscription_plan,
    provider_subscription FROM subscriptions WHERE organization_id=org ORDER BY updated_at DESC LIMIT 1;
  IF input->>'purpose'='EXTRA_CREDITS' AND COALESCE(subscription_status,'')
      NOT IN ('ACTIVE','TRIALING') THEN RETURN jsonb_build_object('reason','INACTIVE_SUBSCRIPTION'); END IF;
  IF input->>'purpose'='EXTRA_CREDITS' AND COALESCE(subscription_plan,'')
      NOT IN ('STARTER','PROFESSIONAL') THEN RETURN jsonb_build_object('reason','UNSUPPORTED_PLAN'); END IF;
  IF input->>'purpose'='PROFESSIONAL' AND subscription_status IN ('ACTIVE','TRIALING')
      AND subscription_plan='PROFESSIONAL' THEN RETURN jsonb_build_object('reason','ACTIVE_PLAN'); END IF;
  IF input->>'purpose'='PROFESSIONAL' AND subscription_status='PAST_DUE'
      AND provider_subscription IS NOT NULL THEN
    RETURN jsonb_build_object('reason','EXISTING_SUBSCRIPTION'); END IF;
  IF intent.id IS NOT NULL THEN RETURN jsonb_build_object('organizationId',org,
    'email',account_email,'checkoutIntentId',intent.id,'reused',true); END IF;
  IF input->>'purpose'='PROFESSIONAL' THEN
    SELECT * INTO intent FROM billing_checkout_sessions WHERE organization_id=org
      AND purpose='PROFESSIONAL' AND status='COMPLETED' AND purchaser_user_id=(input->>'userId')::UUID
      ORDER BY updated_at DESC LIMIT 1;
    IF intent.id IS NOT NULL THEN
      IF intent.updated_at>now()-interval '5 seconds' THEN
        RETURN jsonb_build_object('reason','ACTIVATION_PENDING'); END IF;
      RETURN jsonb_build_object('organizationId',org,'email',account_email,
        'checkoutIntentId',intent.id,'reused',true); END IF;
  END IF;
  INSERT INTO billing_checkout_sessions(organization_id,provider,provider_session_id,purpose,
    quantity,purchaser_user_id,approving_owner_user_id,billing_grant_id,authorized_amount_minor)
  VALUES(org,'DODO','intent:'||gen_random_uuid(),input->>'purpose',
    COALESCE((input->>'quantity')::INTEGER,1),(input->>'userId')::UUID,
    (access->>'approvingOwnerUserId')::UUID,NULLIF(access->>'billingGrantId','')::UUID,
    NULLIF(input->>'amountMinor','')::BIGINT) RETURNING * INTO intent;
  RETURN jsonb_build_object('organizationId',org,'email',account_email,'checkoutIntentId',intent.id);
END $$;

CREATE OR REPLACE FUNCTION authenti8_checkout_actor_authorized(checkout_id UUID,actor UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS(SELECT 1 FROM billing_checkout_sessions checkout WHERE checkout.id=checkout_id
    AND checkout.purchaser_user_id=actor AND checkout.status='PENDING'
    AND (checkout.billing_grant_id IS NULL OR checkout.authorized_amount_minor IS NOT NULL))
$$;

CREATE OR REPLACE FUNCTION authenti8_complete_checkout_intent(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  UPDATE billing_checkout_sessions checkout SET provider_session_id=input->>'sessionId',
    status='COMPLETED',updated_at=now() WHERE checkout.id=(input->>'checkoutIntentId')::UUID
    AND checkout.status='PENDING' AND authenti8_checkout_actor_authorized(checkout.id,
      (input->>'userId')::UUID) RETURNING jsonb_build_object('completed',true)
$$;

CREATE OR REPLACE FUNCTION authenti8_fail_checkout_intent(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  UPDATE billing_checkout_sessions checkout SET status='FAILED',updated_at=now()
  WHERE checkout.id=(input->>'checkoutIntentId')::UUID AND checkout.status IN ('PENDING','COMPLETED')
    AND checkout.purchaser_user_id=(input->>'userId')::UUID
  RETURNING jsonb_build_object('failed',true)
$$;

CREATE OR REPLACE FUNCTION authenti8_billing_grants(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM organization_members WHERE user_id=(input->>'userId')::UUID
    AND business_role='OWNER' AND status='ACTIVE') THEN COALESCE((SELECT jsonb_agg(
    jsonb_build_object('id',grant_row.id,'managerUserId',grant_row.manager_user_id,
      'managerName',account.full_name,'managerEmail',account.email,'expiresAt',grant_row.expires_at,
      'perPurchaseLimitMinor',grant_row.per_purchase_limit_minor,
      'monthlyLimitMinor',grant_row.monthly_limit_minor,'revokedAt',grant_row.revoked_at)
    ORDER BY grant_row.created_at DESC) FROM billing_permission_grants grant_row JOIN users account
      ON account.id=grant_row.manager_user_id WHERE grant_row.organization_id=authenti8_user_organization(
        (input->>'userId')::UUID)), '[]'::JSONB) ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION authenti8_billing_capabilities(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT CASE WHEN member.user_id IS NULL THEN NULL ELSE jsonb_build_object(
    'role',member.business_role,'canPurchase',member.business_role='OWNER' OR
      (member.business_role='MANAGER' AND EXISTS(SELECT 1 FROM billing_permission_grants grant_row
        WHERE grant_row.organization_id=member.organization_id
          AND grant_row.manager_user_id=member.user_id AND grant_row.permission_type='BILLING_PURCHASE'
          AND grant_row.revoked_at IS NULL AND (grant_row.expires_at IS NULL OR grant_row.expires_at>now()))),
    'canManagePortal',member.business_role='OWNER') END
  FROM (SELECT * FROM organization_members WHERE user_id=(input->>'userId')::UUID
    AND status='ACTIVE' ORDER BY created_at LIMIT 1) member
$$;

CREATE OR REPLACE FUNCTION authenti8_verify_delegated_payment_amount() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE checkout billing_checkout_sessions;
BEGIN
  IF NEW.checkout_intent_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO checkout FROM billing_checkout_sessions WHERE id=NEW.checkout_intent_id;
  -- Dodo does not expose checkout-session cancellation. A revocation prevents new
  -- intents, while an already-issued session retains its exact owner-approved amount.
  IF checkout.billing_grant_id IS NOT NULL AND (checkout.status NOT IN ('PENDING','COMPLETED')
      OR NEW.amount_minor IS NULL OR checkout.authorized_amount_minor IS NULL
      OR NEW.amount_minor<>checkout.authorized_amount_minor) THEN
    RAISE EXCEPTION 'delegated payment is not covered by owner authorization'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authenti8_delegated_payment_amount BEFORE INSERT OR UPDATE OF amount_minor,
  checkout_intent_id ON billing_provider_payments FOR EACH ROW
  EXECUTE FUNCTION authenti8_verify_delegated_payment_amount();

REVOKE ALL ON TABLE billing_permission_grants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_billing_access(JSONB),authenti8_manage_billing_grant(JSONB),
  authenti8_billing_grants(JSONB),authenti8_billing_capabilities(JSONB),
  authenti8_checkout_actor_authorized(UUID,UUID),authenti8_verify_delegated_payment_amount()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION authenti8_billing_access(JSONB),authenti8_manage_billing_grant(JSONB),
  authenti8_billing_grants(JSONB),authenti8_billing_capabilities(JSONB) TO service_role;
INSERT INTO schema_migrations(version) VALUES ('046_billing_delegation');
COMMIT;
