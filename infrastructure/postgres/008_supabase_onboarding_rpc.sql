BEGIN;

CREATE OR REPLACE FUNCTION authenti8_create_organization(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE organization_id UUID := gen_random_uuid(); eligible BOOLEAN; created organizations;
BEGIN
  SELECT email_verified_at IS NOT NULL AND status = 'ACTIVE' INTO eligible
  FROM users WHERE id = (input->>'userId')::UUID FOR UPDATE;
  IF COALESCE(eligible, false) = false THEN
    RETURN jsonb_build_object('organization', NULL, 'reason', 'INELIGIBLE');
  END IF;
  IF EXISTS(SELECT 1 FROM organization_members WHERE user_id = (input->>'userId')::UUID) THEN
    RETURN jsonb_build_object('organization', NULL, 'reason', 'CONFLICT');
  END IF;
  INSERT INTO organizations(
    id, name, domain, company_size, expected_monthly_interviews, default_timezone
  ) VALUES (organization_id, input->>'name', input->>'domain', input->>'companySize',
    (input->>'expectedMonthlyInterviews')::INTEGER, input->>'timezone')
  RETURNING * INTO created;
  INSERT INTO organization_members(organization_id, user_id, role, job_role)
  VALUES (organization_id, (input->>'userId')::UUID, 'OWNER', input->>'jobRole');
  INSERT INTO interview_policies(organization_id, name, mode, is_default)
  VALUES (organization_id, 'Strict evidence policy', 'STRICT', true);
  INSERT INTO subscriptions(organization_id, plan_key, status)
  VALUES (organization_id, 'STARTER', 'ACTIVE');
  INSERT INTO credit_transactions(organization_id, amount, kind, reference_id, idempotency_key)
  VALUES (organization_id, 10, 'MONTHLY_ALLOWANCE',
    to_char(date_trunc('month', now()), 'YYYY-MM'), 'allowance:' || organization_id || ':' ||
    to_char(date_trunc('month', now()), 'YYYY-MM'));
  INSERT INTO audit_logs(organization_id, actor_user_id, action, target_type, target_id)
  VALUES (organization_id, (input->>'userId')::UUID,
    'ORGANIZATION_CREATED', 'organization', organization_id::TEXT);
  RETURN jsonb_build_object('organization', jsonb_build_object(
    'id', created.id, 'name', created.name, 'domain', created.domain, 'role', 'OWNER'));
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('organization', NULL, 'reason', 'CONFLICT');
END $$;

REVOKE ALL ON FUNCTION authenti8_create_organization(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_create_organization(JSONB) TO service_role;

INSERT INTO schema_migrations(version) VALUES ('008_supabase_onboarding_rpc');
COMMIT;
