BEGIN;

CREATE OR REPLACE FUNCTION authenti8_claim_commercial_email(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE claimed commercial_email_outbox;
BEGIN
  INSERT INTO commercial_email_outbox(lead_id, recipient, kind, deduplication_key)
  SELECT lead.id, account.email, 'FOLLOW_UP_REMINDER', 'follow-up:' || lead.id || ':' ||
    lead.follow_up_version FROM commercial_leads lead
  JOIN users account ON account.id = lead.follow_up_owner
  JOIN platform_staff staff ON staff.user_id = account.id AND staff.status = 'ACTIVE'
  WHERE lead.follow_up_reminder_at <= now() AND lead.follow_up_completed_at IS NULL
    AND lead.follow_up_reminded_at IS NULL ON CONFLICT DO NOTHING;
  UPDATE commercial_email_outbox SET status = 'PENDING', lease_until = NULL
    WHERE status = 'PROCESSING' AND lease_until <= now();
  UPDATE commercial_email_outbox queued SET status = 'CANCELLED', lease_until = NULL
    WHERE queued.kind = 'FOLLOW_UP_REMINDER' AND queued.status IN ('PENDING', 'PROCESSING')
      AND NOT EXISTS (SELECT 1 FROM commercial_leads lead WHERE lead.id = queued.lead_id
        AND lead.follow_up_completed_at IS NULL AND lead.follow_up_reminded_at IS NULL
        AND queued.deduplication_key = 'follow-up:' || lead.id || ':' || lead.follow_up_version);
  SELECT * INTO claimed FROM commercial_email_outbox queued WHERE queued.status = 'PENDING'
    AND queued.available_at <= now() AND (queued.kind <> 'FOLLOW_UP_REMINDER' OR EXISTS
      (SELECT 1 FROM commercial_leads lead WHERE lead.id = queued.lead_id
        AND lead.follow_up_completed_at IS NULL AND lead.follow_up_reminded_at IS NULL
        AND queued.deduplication_key = 'follow-up:' || lead.id || ':' || lead.follow_up_version))
    ORDER BY queued.created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF claimed.id IS NULL THEN RETURN NULL; END IF;
  UPDATE commercial_email_outbox SET status = 'PROCESSING', attempts = attempts + 1,
    lease_until = now() + interval '30 seconds' WHERE id = claimed.id RETURNING * INTO claimed;
  RETURN (SELECT jsonb_build_object('id', claimed.id, 'attempts', claimed.attempts,
    'recipient', claimed.recipient, 'kind', claimed.kind, 'leadType', lead.lead_type,
    'fullName', lead.full_name, 'email', lead.email, 'companyName', lead.company_name,
    'followUpDueAt', lead.follow_up_due_at)
    FROM commercial_leads lead WHERE lead.id = claimed.lead_id);
END $$;

CREATE OR REPLACE FUNCTION authenti8_validate_commercial_email(input JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE valid BOOLEAN;
BEGIN
  SELECT mail.kind <> 'FOLLOW_UP_REMINDER' OR EXISTS (SELECT 1 FROM commercial_leads lead
    WHERE lead.id = mail.lead_id AND lead.follow_up_completed_at IS NULL
      AND lead.follow_up_reminded_at IS NULL
      AND mail.deduplication_key = 'follow-up:' || lead.id || ':' || lead.follow_up_version)
    INTO valid FROM commercial_email_outbox mail WHERE mail.id = (input->>'id')::UUID
      AND mail.status = 'PROCESSING' AND mail.attempts = (input->>'attempts')::INTEGER FOR UPDATE;
  IF COALESCE(valid, false) = false THEN
    UPDATE commercial_email_outbox SET status = 'CANCELLED', lease_until = NULL
      WHERE id = (input->>'id')::UUID AND status = 'PROCESSING'
        AND attempts = (input->>'attempts')::INTEGER;
  END IF;
  RETURN COALESCE(valid, false);
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION authenti8_complete_commercial_email(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed INTEGER; completed_lead UUID; completed_kind TEXT; completed_key TEXT;
BEGIN
  UPDATE commercial_email_outbox SET status = 'SENT', sent_at = now(), lease_until = NULL
    WHERE id = (input->>'id')::UUID AND status = 'PROCESSING'
      AND attempts = (input->>'attempts')::INTEGER
    RETURNING lead_id, kind, deduplication_key INTO completed_lead, completed_kind, completed_key;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed = 1 AND completed_kind = 'FOLLOW_UP_REMINDER' THEN
    UPDATE commercial_leads SET follow_up_reminded_at = now() WHERE id = completed_lead
      AND completed_key = 'follow-up:' || id || ':' || follow_up_version;
  END IF;
  RETURN jsonb_build_object('completed', changed = 1);
EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('completed', false);
END $$;

CREATE OR REPLACE FUNCTION authenti8_user_organization(user_id UUID) RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT organization_id FROM organization_members
  WHERE organization_members.user_id = authenti8_user_organization.user_id
    AND status = 'ACTIVE' ORDER BY created_at LIMIT 1
$$;

CREATE OR REPLACE FUNCTION authenti8_begin_checkout(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID; account_email TEXT; intent billing_checkout_sessions;
  subscription_status TEXT; subscription_plan TEXT; provider_subscription TEXT;
BEGIN
  SELECT member.organization_id, account.email INTO org, account_email
  FROM organization_members member JOIN users account ON account.id = member.user_id
  WHERE member.user_id = (input->>'userId')::UUID AND member.business_role = 'OWNER'
    AND member.status = 'ACTIVE' ORDER BY member.created_at LIMIT 1;
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

CREATE OR REPLACE FUNCTION authenti8_complete_checkout_intent(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE billing_checkout_sessions checkout SET provider_session_id = input->>'sessionId',
    status = 'COMPLETED', updated_at = now() FROM organization_members member
  WHERE checkout.id = (input->>'checkoutIntentId')::UUID AND checkout.status = 'PENDING'
    AND member.organization_id = checkout.organization_id
    AND member.user_id = (input->>'userId')::UUID AND member.business_role = 'OWNER'
    AND member.status = 'ACTIVE' RETURNING jsonb_build_object('completed', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_fail_checkout_intent(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE billing_checkout_sessions checkout SET status = 'FAILED', updated_at = now()
  FROM organization_members member WHERE checkout.id = (input->>'checkoutIntentId')::UUID
    AND checkout.status IN ('PENDING', 'COMPLETED')
    AND member.organization_id = checkout.organization_id
    AND member.user_id = (input->>'userId')::UUID AND member.business_role = 'OWNER'
    AND member.status = 'ACTIVE' RETURNING jsonb_build_object('failed', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_billing_portal_context(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('subscriptionId', subscription.provider_subscription_id)
  FROM subscriptions subscription JOIN organization_members member
    ON member.organization_id = subscription.organization_id
  WHERE member.user_id = (input->>'userId')::UUID AND member.business_role = 'OWNER'
    AND member.status = 'ACTIVE' AND subscription.provider = 'DODO'
    AND subscription.plan_key = 'PROFESSIONAL'
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
  WHERE member.user_id = (input->>'userId')::UUID AND member.business_role = 'OWNER'
    AND member.status = 'ACTIVE' AND checkout.provider = 'DODO'
    AND checkout.purpose = 'PROFESSIONAL' AND checkout.status = 'COMPLETED'
    AND checkout.provider_session_id NOT LIKE 'intent:%'
  ORDER BY checkout.updated_at DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION authenti8_commercial_organizations(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM platform_staff WHERE user_id =
    (input->>'userId')::UUID AND role = 'PLATFORM_FOUNDER' AND status = 'ACTIVE')
  THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', match.id, 'name', match.name,
    'domain', match.domain) ORDER BY match.name) FROM (SELECT id, name, domain FROM organizations
    WHERE status = 'ACTIVE' AND (position(lower(input->>'query') IN lower(name)) > 0
      OR position(lower(input->>'query') IN lower(domain)) > 0)
    ORDER BY name LIMIT 20) match), '[]'::JSONB) ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION authenti8_bootstrap_platform_founder(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; configured TEXT := lower(trim(input->>'founderEmail'));
  previous platform_staff;
BEGIN
  IF configured = '' OR NOT EXISTS (SELECT 1 FROM users WHERE id = actor
      AND normalized_email = configured AND status = 'ACTIVE') THEN
    RETURN jsonb_build_object('created', false); END IF;
  SELECT * INTO previous FROM platform_staff WHERE user_id = actor FOR UPDATE;
  INSERT INTO platform_staff(user_id, role, status, created_by)
    VALUES (actor, 'PLATFORM_FOUNDER', 'ACTIVE', actor) ON CONFLICT (user_id) DO UPDATE SET
      role = 'PLATFORM_FOUNDER', status = 'ACTIVE', updated_at = now();
  IF previous.user_id IS NULL OR previous.role <> 'PLATFORM_FOUNDER'
      OR previous.status <> 'ACTIVE' THEN
    INSERT INTO audit_logs(actor_user_id, action, target_type, target_id, reason,
      previous_value, new_value) VALUES (actor, 'PLATFORM_FOUNDER_BOOTSTRAPPED',
      'platform_staff', actor::TEXT, 'Configured founder identity restored',
      CASE WHEN previous.user_id IS NULL THEN NULL ELSE jsonb_build_object(
        'role', previous.role, 'status', previous.status) END,
      jsonb_build_object('role', 'PLATFORM_FOUNDER', 'status', 'ACTIVE'));
  END IF;
  RETURN jsonb_build_object('created', true, 'role', 'PLATFORM_FOUNDER', 'status', 'ACTIVE');
END $$;

CREATE OR REPLACE FUNCTION authenti8_convert_commercial_lead(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; lead commercial_leads; organization UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_staff WHERE user_id = actor
      AND role = 'PLATFORM_FOUNDER' AND status = 'ACTIVE') THEN
    RETURN jsonb_build_object('converted', false, 'reason', 'NOT_AUTHORIZED'); END IF;
  organization := (input->>'organizationId')::UUID;
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = organization AND status = 'ACTIVE') THEN
    RETURN jsonb_build_object('converted', false, 'reason', 'INVALID_ORGANIZATION'); END IF;
  SELECT * INTO lead FROM commercial_leads WHERE id = (input->>'leadId')::UUID FOR UPDATE;
  IF lead.id IS NULL THEN RETURN jsonb_build_object('converted', false, 'reason', 'INVALID_LEAD'); END IF;
  IF lead.converted_organization_id IS NOT NULL THEN RETURN jsonb_build_object('converted',
    lead.converted_organization_id = organization, 'reason', 'ALREADY_CONVERTED'); END IF;
  UPDATE commercial_leads SET converted_organization_id = organization, stage = 'WON',
    updated_at = now() WHERE id = lead.id;
  INSERT INTO commercial_lead_activities(lead_id, actor_user_id, activity_type, detail)
    VALUES (lead.id, actor, 'CONVERTED', jsonb_build_object('organizationId', organization));
  RETURN jsonb_build_object('converted', true, 'organizationId', organization);
EXCEPTION WHEN invalid_text_representation THEN
  RETURN jsonb_build_object('converted', false, 'reason', 'INVALID_CONVERSION');
END $$;

REVOKE ALL ON FUNCTION authenti8_commercial_organizations(JSONB),
  authenti8_bootstrap_platform_founder(JSONB),
  authenti8_convert_commercial_lead(JSONB), authenti8_validate_commercial_email(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_commercial_organizations(JSONB),
  authenti8_bootstrap_platform_founder(JSONB),
  authenti8_convert_commercial_lead(JSONB), authenti8_validate_commercial_email(JSONB)
  TO service_role;

INSERT INTO schema_migrations(version) VALUES ('045_growth_authorization_controls')
  ON CONFLICT DO NOTHING;
COMMIT;
