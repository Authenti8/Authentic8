BEGIN;

CREATE TABLE platform_administrators (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE platform_administrators ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION authenti8_reject_audit_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER authenti8_audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION authenti8_reject_audit_mutation();

CREATE TABLE admin_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by UUID NOT NULL REFERENCES platform_administrators(user_id),
  approved_by UUID REFERENCES platform_administrators(user_id),
  action TEXT NOT NULL CHECK (action IN ('DISABLE_RULE', 'REFUND_CREDITS')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) >= 10),
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPLIED', 'REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
ALTER TABLE admin_change_requests ENABLE ROW LEVEL SECURITY;

CREATE TABLE candidate_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id UUID NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'REVIEWED', 'RESOLVED')),
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX candidate_disputes_status_idx ON candidate_disputes(status, created_at);
CREATE UNIQUE INDEX candidate_disputes_unresolved_idx ON candidate_disputes(interview_id)
  WHERE status IN ('OPEN', 'REVIEWED');
ALTER TABLE candidate_disputes ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION authenti8_submit_candidate_dispute(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE token candidate_verification_tokens; dispute_id UUID;
  explanation TEXT := trim(COALESCE(input->>'reason', ''));
BEGIN
  IF length(explanation) < 20 OR length(explanation) > 2000 THEN
    RETURN jsonb_build_object('submitted', false, 'reason', 'INVALID_REASON');
  END IF;
  SELECT candidate.* INTO token FROM candidate_verification_tokens candidate
  JOIN interviews interview ON interview.id = candidate.interview_id
  WHERE candidate.token_hash = input->>'tokenHash' AND candidate.expires_at > now()
    AND interview.data_deleted_at IS NULL
    AND candidate.candidate_email = interview.candidate_email
    AND NOT EXISTS (SELECT 1 FROM candidate_verification_tokens newer
      WHERE newer.interview_id = candidate.interview_id
        AND (newer.created_at, newer.id) > (candidate.created_at, candidate.id));
  IF token.id IS NULL THEN
    RETURN jsonb_build_object('submitted', false, 'reason', 'TOKEN_UNAVAILABLE');
  END IF;
  SELECT id INTO dispute_id FROM candidate_disputes
    WHERE interview_id = token.interview_id AND status IN ('OPEN', 'REVIEWED');
  IF dispute_id IS NOT NULL THEN
    RETURN jsonb_build_object('submitted', true, 'replayed', true, 'disputeId', dispute_id);
  END IF;
  INSERT INTO candidate_disputes(interview_id, reason)
    VALUES (token.interview_id, explanation) RETURNING id INTO dispute_id;
  RETURN jsonb_build_object('submitted', true, 'disputeId', dispute_id);
EXCEPTION WHEN unique_violation THEN
  SELECT id INTO dispute_id FROM candidate_disputes
    WHERE interview_id = token.interview_id AND status IN ('OPEN', 'REVIEWED');
  RETURN jsonb_build_object('submitted', true, 'replayed', true, 'disputeId', dispute_id);
END $$;

CREATE TABLE application_versions (
  application TEXT NOT NULL CHECK (application IN
    ('WINDOWS_AGENT', 'MACOS_AGENT', 'CANDIDATE_EXTENSION', 'RECRUITER_EXTENSION')),
  platform TEXT NOT NULL,
  version TEXT NOT NULL,
  release_channel TEXT NOT NULL CHECK (release_channel IN ('DEVELOPMENT', 'STAGING', 'PRODUCTION')),
  source_commit_sha TEXT NOT NULL,
  artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  minimum_supported BOOLEAN NOT NULL DEFAULT false,
  released_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (application, platform, version, release_channel)
);
ALTER TABLE application_versions ENABLE ROW LEVEL SECURITY;

CREATE TABLE organization_retention_policies (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  report_days INTEGER NOT NULL DEFAULT 90 CHECK (report_days BETWEEN 1 AND 3650),
  evidence_days INTEGER NOT NULL DEFAULT 30 CHECK (evidence_days BETWEEN 1 AND 365),
  anonymize_days INTEGER NOT NULL DEFAULT 90 CHECK (anonymize_days BETWEEN 1 AND 3650),
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (evidence_days <= anonymize_days),
  CHECK (report_days <= anonymize_days)
);
ALTER TABLE organization_retention_policies ENABLE ROW LEVEL SECURITY;

ALTER TABLE interviews
  ADD COLUMN evidence_due_at TIMESTAMPTZ,
  ADD COLUMN report_due_at TIMESTAMPTZ,
  ADD COLUMN deletion_due_at TIMESTAMPTZ,
  ADD COLUMN evidence_deleted_at TIMESTAMPTZ,
  ADD COLUMN report_deleted_at TIMESTAMPTZ,
  ADD COLUMN data_deleted_at TIMESTAMPTZ;
CREATE INDEX interviews_retention_due_idx ON interviews(deletion_due_at)
  WHERE data_deleted_at IS NULL;

CREATE OR REPLACE FUNCTION authenti8_set_interview_retention() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE evidence_keep INTEGER; report_keep INTEGER; identity_keep INTEGER; anchor TIMESTAMPTZ;
BEGIN
  IF NEW.status IN ('MEETING_COMPLETED', 'REPORT_PROCESSING', 'REPORT_READY', 'FAILED',
      'UNABLE_TO_VERIFY', 'CONSENT_DECLINED', 'CANCELLED', 'EXCLUDED', 'SYNC_FAILED',
      'NO_CREDITS', 'SUBSCRIPTION_INACTIVE') THEN
    SELECT policy.evidence_days, policy.report_days, policy.anonymize_days
      INTO evidence_keep, report_keep, identity_keep
      FROM organization_retention_policies policy
      WHERE policy.organization_id = NEW.organization_id;
    anchor := COALESCE(NEW.monitoring_ended_at, NEW.scheduled_end, now());
    NEW.evidence_due_at := COALESCE(NEW.evidence_due_at,
      anchor + make_interval(days => COALESCE(evidence_keep, 30)));
    NEW.report_due_at := COALESCE(NEW.report_due_at,
      anchor + make_interval(days => COALESCE(report_keep, 90)));
    NEW.deletion_due_at := COALESCE(NEW.deletion_due_at,
      anchor + make_interval(days => COALESCE(identity_keep, 90)));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authenti8_interview_retention_before_write
BEFORE INSERT OR UPDATE OF status, monitoring_ended_at ON interviews FOR EACH ROW
EXECUTE FUNCTION authenti8_set_interview_retention();

UPDATE interviews SET evidence_due_at = COALESCE(monitoring_ended_at, scheduled_end, now())
    + interval '30 days', report_due_at = COALESCE(monitoring_ended_at, scheduled_end, now())
    + interval '90 days', deletion_due_at = COALESCE(monitoring_ended_at, scheduled_end, now())
    + interval '90 days'
WHERE deletion_due_at IS NULL AND status IN ('MEETING_COMPLETED', 'REPORT_PROCESSING',
  'REPORT_READY', 'FAILED', 'UNABLE_TO_VERIFY', 'CONSENT_DECLINED', 'CANCELLED',
  'EXCLUDED', 'SYNC_FAILED', 'NO_CREDITS', 'SUBSCRIPTION_INACTIVE');

ALTER FUNCTION authenti8_meeting_detail(JSONB) RENAME TO authenti8_meeting_detail_retained;
CREATE OR REPLACE FUNCTION authenti8_meeting_detail(input JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM interviews WHERE id = (input->>'interviewId')::UUID
      AND data_deleted_at IS NOT NULL) THEN RETURN NULL; END IF;
  RETURN authenti8_meeting_detail_retained(input);
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION authenti8_run_retention(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE item RECORD; removed INTEGER := 0; batch_size INTEGER; previous_guard TEXT :=
  current_setting('authenti8.retention_delete', true); clock TIMESTAMPTZ :=
  COALESCE((input->>'at')::TIMESTAMPTZ, now());
BEGIN
  PERFORM set_config('authenti8.retention_delete', 'enabled', true);
  LOOP
    batch_size := 0;
    FOR item IN SELECT interview.* FROM interviews interview
      WHERE (interview.evidence_deleted_at IS NULL AND interview.evidence_due_at <= clock)
        OR (interview.report_deleted_at IS NULL AND interview.report_due_at <= clock)
        OR (interview.data_deleted_at IS NULL AND interview.deletion_due_at <= clock)
      ORDER BY LEAST(interview.evidence_due_at, interview.report_due_at,
        interview.deletion_due_at) FOR UPDATE SKIP LOCKED LIMIT 100 LOOP
    IF item.evidence_deleted_at IS NULL AND item.evidence_due_at <= clock THEN
      DELETE FROM recruiter_live_events WHERE interview_id = item.id;
      DELETE FROM detection_incidents WHERE verification_session_id IN
        (SELECT id FROM verification_sessions WHERE interview_id = item.id);
      DELETE FROM telemetry_events WHERE verification_session_id IN
        (SELECT id FROM verification_sessions WHERE interview_id = item.id);
      DELETE FROM agent_heartbeats WHERE verification_session_id IN
        (SELECT id FROM verification_sessions WHERE interview_id = item.id);
      UPDATE interviews SET evidence_deleted_at = clock, updated_at = clock WHERE id = item.id;
    END IF;
    IF item.report_deleted_at IS NULL AND item.report_due_at <= clock THEN
      UPDATE interviews SET report_id = NULL, report_deleted_at = clock, updated_at = clock
        WHERE id = item.id;
      DELETE FROM reports WHERE interview_id = item.id;
    END IF;
    IF item.data_deleted_at IS NULL AND item.deletion_due_at <= clock THEN
      DELETE FROM candidate_devices WHERE verification_session_id IN
        (SELECT id FROM verification_sessions WHERE interview_id = item.id);
      DELETE FROM interview_participants WHERE interview_id = item.id AND is_external;
      UPDATE verification_sessions SET candidate_email =
        'deleted+' || id || '@redacted.invalid' WHERE interview_id = item.id;
      UPDATE candidate_verification_tokens SET candidate_email =
        'deleted+' || id || '@redacted.invalid',
        token_hash = encode(digest('deleted:' || id::TEXT, 'sha256'), 'hex')
        WHERE interview_id = item.id;
      UPDATE candidate_consents SET candidate_email =
        'deleted+' || id || '@redacted.invalid', ip_address = NULL, user_agent = NULL
        WHERE interview_id = item.id;
      DELETE FROM candidate_disputes WHERE interview_id = item.id;
      DELETE FROM auth_email_outbox WHERE interview_id = item.id;
      UPDATE interviews SET candidate_name = NULL,
        candidate_email = 'deleted+' || item.id || '@redacted.invalid', report_id = NULL,
        data_deleted_at = clock, updated_at = clock WHERE id = item.id;
    END IF;
    INSERT INTO audit_logs(organization_id, action, target_type, target_id, reason,
      new_value) VALUES (item.organization_id, 'RETENTION_APPLIED',
      'interview', item.id::TEXT, 'Organization retention policy elapsed',
      jsonb_build_object('processedAt', clock, 'evidenceDeleted', item.evidence_due_at <= clock,
        'reportDeleted', item.report_due_at <= clock, 'identityDeleted', item.deletion_due_at <= clock));
      removed := removed + 1;
      batch_size := batch_size + 1;
    END LOOP;
    EXIT WHEN batch_size = 0;
  END LOOP;
  PERFORM set_config('authenti8.retention_delete', COALESCE(previous_guard, ''), true);
  RETURN jsonb_build_object('processed', removed);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('authenti8.retention_delete', COALESCE(previous_guard, ''), true);
  RAISE;
END $$;

CREATE OR REPLACE FUNCTION authenti8_admin_overview(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; result JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_administrators WHERE user_id = actor) THEN RETURN NULL; END IF;
  INSERT INTO audit_logs(actor_user_id, action, target_type, reason, new_value)
    VALUES (actor, 'CUSTOMER_DATA_ACCESSED', 'admin_overview', 'Internal support review',
      jsonb_build_object('query', left(COALESCE(input->>'query', ''), 120)));
  SELECT jsonb_build_object('organizations', COALESCE(jsonb_agg(jsonb_build_object(
    'id', org.id, 'name', org.name, 'domain', org.domain, 'status', org.status,
    'subscriptionStatus', subscription.status, 'plan', subscription.plan_key,
    'calendarError', sync.last_error_code, 'activeAgents', (SELECT count(DISTINCT session.id)
      FROM verification_sessions session JOIN agent_heartbeats heartbeat
        ON heartbeat.verification_session_id = session.id
      JOIN interviews active_interview ON active_interview.id = session.interview_id
      WHERE active_interview.organization_id = org.id AND session.status = 'MONITORING_ACTIVE'
        AND heartbeat.received_at >= now() - interval '15 seconds'),
    'confirmedDetections', (SELECT count(*) FROM detection_incidents incident
      JOIN verification_sessions session ON session.id = incident.verification_session_id
      JOIN interviews detected_interview ON detected_interview.id = session.interview_id
      WHERE detected_interview.organization_id = org.id AND incident.result = 'CONFIRMED'),
    'openDisputes', (SELECT count(*) FROM candidate_disputes
      dispute JOIN interviews interview ON interview.id = dispute.interview_id
      WHERE interview.organization_id = org.id
        AND dispute.status IN ('OPEN', 'REVIEWED')))
    ORDER BY org.created_at DESC), '[]'::JSONB)) INTO result
  FROM organizations org
  LEFT JOIN LATERAL (SELECT candidate.status, candidate.plan_key FROM subscriptions candidate
    WHERE candidate.organization_id = org.id ORDER BY candidate.updated_at DESC LIMIT 1)
    subscription ON true
  LEFT JOIN LATERAL (SELECT state.last_error_code FROM google_integrations integration
    JOIN calendar_sync_states state ON state.google_integration_id = integration.id
    WHERE integration.organization_id = org.id AND integration.status = 'ACTIVE'
    ORDER BY state.updated_at DESC LIMIT 1) sync ON true
  WHERE NULLIF(input->>'query', '') IS NULL OR lower(org.name || ' ' || org.domain)
    LIKE '%' || replace(replace(lower(input->>'query'), '%', '\%'), '_', '\_') || '%' ESCAPE '\';
  RETURN result || jsonb_build_object('rulePacks', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'platform', platform, 'version', version, 'expiresAt', expires_at,
      'disabledAt', disabled_at) ORDER BY platform, published_at DESC)
      FROM detection_rule_packs), '[]'::JSONB),
    'applicationVersions', COALESCE((SELECT jsonb_agg(to_jsonb(version) ORDER BY released_at DESC)
      FROM application_versions version), '[]'::JSONB),
    'disputes', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', dispute.id,
      'interviewId', dispute.interview_id, 'reason', dispute.reason, 'status', dispute.status,
      'createdAt', dispute.created_at) ORDER BY dispute.created_at DESC)
      FROM candidate_disputes dispute
      WHERE dispute.status IN ('OPEN', 'REVIEWED')), '[]'::JSONB));
END $$;

CREATE OR REPLACE FUNCTION authenti8_request_admin_change(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; request_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_administrators WHERE user_id = actor)
    OR COALESCE(length(trim(input->>'reason')), 0) < 10 THEN
    RETURN jsonb_build_object('created', false, 'reason', 'NOT_AUTHORIZED_OR_REASON_REQUIRED');
  END IF;
  IF input->>'action' = 'REFUND_CREDITS' AND (input->>'payload' IS NULL
      OR input->'payload'->>'amount' !~ '^[1-9][0-9]{0,5}$') THEN
    RETURN jsonb_build_object('created', false, 'reason', 'INVALID_CHANGE'); END IF;
  INSERT INTO admin_change_requests(requested_by, action, target_id, reason, payload)
    VALUES (actor, input->>'action', input->>'targetId', trim(input->>'reason'),
      COALESCE(input->'payload', '{}'::JSONB)) RETURNING id INTO request_id;
  INSERT INTO audit_logs(actor_user_id, action, target_type, target_id, reason, new_value)
    VALUES (actor, 'ADMIN_CHANGE_REQUESTED', 'admin_change_request', request_id::TEXT,
      trim(input->>'reason'), input - 'userId');
  RETURN jsonb_build_object('created', true, 'requestId', request_id);
EXCEPTION WHEN check_violation OR foreign_key_violation THEN
  RETURN jsonb_build_object('created', false, 'reason', 'INVALID_CHANGE');
END $$;

CREATE OR REPLACE FUNCTION authenti8_resolve_candidate_dispute(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; dispute candidate_disputes;
  next_status TEXT := input->>'status'; explanation TEXT := trim(COALESCE(input->>'resolution', ''));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_administrators WHERE user_id = actor) THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'NOT_AUTHORIZED'); END IF;
  IF next_status NOT IN ('REVIEWED', 'RESOLVED')
      OR (next_status = 'RESOLVED' AND length(explanation) < 10) THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'INVALID_RESOLUTION'); END IF;
  SELECT * INTO dispute FROM candidate_disputes WHERE id = (input->>'disputeId')::UUID FOR UPDATE;
  IF dispute.id IS NULL OR dispute.status = 'RESOLVED' THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'DISPUTE_UNAVAILABLE'); END IF;
  UPDATE candidate_disputes SET status = next_status,
    resolution = CASE WHEN explanation = '' THEN resolution ELSE explanation END,
    resolved_at = CASE WHEN next_status = 'RESOLVED' THEN now() ELSE NULL END
    WHERE id = dispute.id;
  INSERT INTO audit_logs(organization_id, actor_user_id, action, target_type, target_id,
    reason, previous_value, new_value)
  SELECT interview.organization_id, actor, 'CANDIDATE_DISPUTE_' || next_status,
    'candidate_dispute', dispute.id::TEXT, 'Candidate dispute status changed',
    jsonb_build_object('status', dispute.status), jsonb_build_object('status', next_status,
      'resolutionDigest', CASE WHEN explanation = '' THEN NULL
        ELSE encode(digest(explanation, 'sha256'), 'hex') END)
  FROM interviews interview WHERE interview.id = dispute.interview_id;
  RETURN jsonb_build_object('updated', true);
EXCEPTION WHEN invalid_text_representation THEN
  RETURN jsonb_build_object('updated', false, 'reason', 'INVALID_RESOLUTION');
END $$;

CREATE OR REPLACE FUNCTION authenti8_approve_admin_change(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; request admin_change_requests;
  previous JSONB; updated JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_administrators WHERE user_id = actor) THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'NOT_AUTHORIZED'); END IF;
  SELECT * INTO request FROM admin_change_requests WHERE id = (input->>'requestId')::UUID
    AND status = 'PENDING' FOR UPDATE;
  IF request.id IS NULL OR request.requested_by = actor THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'SECOND_ADMIN_REQUIRED'); END IF;
  IF request.action = 'DISABLE_RULE' THEN
    SELECT to_jsonb(rule) INTO previous FROM detection_rules rule WHERE id = request.target_id::UUID;
    UPDATE detection_rules SET enabled = false, status = 'DISABLED', disabled_at = now()
      WHERE id = request.target_id::UUID RETURNING to_jsonb(detection_rules) INTO updated;
  ELSE
    SELECT jsonb_build_object('balance', COALESCE(sum(amount), 0)) INTO previous
      FROM credit_transactions WHERE organization_id = request.target_id::UUID;
    INSERT INTO credit_transactions(organization_id, amount, kind, reference_id, idempotency_key)
      VALUES (request.target_id::UUID, (request.payload->>'amount')::INTEGER,
        'EXTRA_REVERSAL', request.id::TEXT, 'admin-refund:' || request.id);
    SELECT jsonb_build_object('balance', COALESCE(sum(amount), 0)) INTO updated
      FROM credit_transactions WHERE organization_id = request.target_id::UUID;
  END IF;
  IF updated IS NULL THEN RETURN jsonb_build_object('applied', false, 'reason', 'TARGET_UNAVAILABLE'); END IF;
  UPDATE admin_change_requests SET approved_by = actor, status = 'APPLIED', resolved_at = now()
    WHERE id = request.id;
  INSERT INTO audit_logs(actor_user_id, action, target_type, target_id, reason,
    previous_value, new_value) VALUES (actor, request.action, 'admin_change_request',
    request.id::TEXT, request.reason, previous, updated);
  RETURN jsonb_build_object('applied', true);
EXCEPTION WHEN foreign_key_violation THEN
  RETURN jsonb_build_object('applied', false, 'reason', 'TARGET_UNAVAILABLE');
WHEN invalid_text_representation OR check_violation THEN
  RETURN jsonb_build_object('applied', false, 'reason', 'INVALID_CHANGE');
END $$;

REVOKE ALL ON FUNCTION authenti8_run_retention(JSONB), authenti8_admin_overview(JSONB),
  authenti8_request_admin_change(JSONB), authenti8_approve_admin_change(JSONB),
  authenti8_resolve_candidate_dispute(JSONB), authenti8_submit_candidate_dispute(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_run_retention(JSONB), authenti8_admin_overview(JSONB),
  authenti8_request_admin_change(JSONB), authenti8_approve_admin_change(JSONB),
  authenti8_resolve_candidate_dispute(JSONB), authenti8_submit_candidate_dispute(JSONB)
  TO service_role;

INSERT INTO schema_migrations(version) VALUES ('040_admin_privacy_retention') ON CONFLICT DO NOTHING;
COMMIT;
