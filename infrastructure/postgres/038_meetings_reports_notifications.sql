BEGIN;
ALTER TABLE recruiter_live_events ADD COLUMN integrity_hash TEXT;
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_interview_id_key;
ALTER TABLE reports ADD CONSTRAINT reports_interview_version_key UNIQUE (interview_id, version);
ALTER TABLE reports ADD COLUMN rule_pack_version TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE workspace_notifications
  ADD COLUMN title TEXT NOT NULL DEFAULT 'Authenti8 update',
  ADD COLUMN severity TEXT NOT NULL DEFAULT 'INFO'
    CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  ADD COLUMN link_path TEXT;
CREATE INDEX interviews_org_interviewer_search_idx
  ON interviews(organization_id, lower(organizer_email));
CREATE TABLE report_generation_jobs (
  interview_id UUID PRIMARY KEY REFERENCES interviews(id) ON DELETE CASCADE,
  available_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX report_generation_jobs_claim_idx
  ON report_generation_jobs(status, available_at);
ALTER TABLE report_generation_jobs ENABLE ROW LEVEL SECURITY;
CREATE TABLE notification_email_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES workspace_notifications(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (notification_id, recipient)
);
CREATE INDEX notification_email_outbox_claim_idx
  ON notification_email_outbox(status, available_at);
ALTER TABLE notification_email_outbox ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION authenti8_recruiter_event_hash() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.integrity_hash := encode(digest(convert_to(concat_ws('|', NEW.interview_id::TEXT,
    NEW.source_kind, NEW.source_reference, NEW.kind, NEW.message, NEW.occurred_at::TEXT,
    NEW.metadata::TEXT), 'UTF8'), 'sha256'), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER authenti8_recruiter_event_hash_before_insert
BEFORE INSERT ON recruiter_live_events FOR EACH ROW
EXECUTE FUNCTION authenti8_recruiter_event_hash();
UPDATE recruiter_live_events SET integrity_hash = encode(digest(convert_to(concat_ws('|',
  interview_id::TEXT, source_kind, source_reference, kind, message, occurred_at::TEXT,
  metadata::TEXT), 'UTF8'), 'sha256'), 'hex') WHERE integrity_hash IS NULL;
ALTER TABLE recruiter_live_events ALTER COLUMN integrity_hash SET NOT NULL;
CREATE OR REPLACE FUNCTION authenti8_reject_evidence_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF current_setting('authenti8.retention_delete', true) = 'enabled' AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;
CREATE TRIGGER authenti8_telemetry_append_only BEFORE UPDATE OR DELETE ON telemetry_events
  FOR EACH ROW EXECUTE FUNCTION authenti8_reject_evidence_mutation();
CREATE TRIGGER authenti8_incidents_append_only BEFORE UPDATE OR DELETE ON detection_incidents
  FOR EACH ROW EXECUTE FUNCTION authenti8_reject_evidence_mutation();
CREATE TRIGGER authenti8_live_events_append_only BEFORE UPDATE OR DELETE ON recruiter_live_events
  FOR EACH ROW EXECUTE FUNCTION authenti8_reject_evidence_mutation();
CREATE TRIGGER authenti8_reports_append_only BEFORE UPDATE OR DELETE ON reports
  FOR EACH ROW EXECUTE FUNCTION authenti8_reject_evidence_mutation();
CREATE OR REPLACE FUNCTION authenti8_meetings_page(input JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID := authenti8_user_organization((input->>'userId')::UUID);
  org_timezone TEXT;
  page_size INTEGER := 25; rows JSONB; next_start TIMESTAMPTZ; next_id UUID;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('items', '[]'::JSONB, 'nextCursor', NULL); END IF;
  IF NULLIF(input->>'limit', '') IS NOT NULL THEN
    IF input->>'limit' !~ '^[1-9][0-9]{0,2}$' OR (input->>'limit')::INTEGER > 100 THEN RETURN
      jsonb_build_object('items', '[]'::JSONB, 'nextCursor', NULL, 'invalid', true); END IF;
    page_size := (input->>'limit')::INTEGER;
  END IF;
  SELECT default_timezone INTO org_timezone FROM organizations WHERE id = org;
  WITH filtered AS (SELECT interview.* FROM interviews interview
    WHERE interview.organization_id = org AND interview.status <> 'EXCLUDED'
      AND (NULLIF(input->>'from', '') IS NULL
        OR interview.scheduled_start >= ((input->>'from')::DATE AT TIME ZONE org_timezone))
      AND (NULLIF(input->>'to', '') IS NULL
        OR interview.scheduled_start < (((input->>'to')::DATE + 1) AT TIME ZONE org_timezone))
      AND (NULLIF(input->>'interviewer', '') IS NULL
        OR lower(interview.organizer_email) = lower(input->>'interviewer'))
      AND (NULLIF(input->>'candidate', '') IS NULL OR
        lower(interview.organization_id::TEXT || ' ' || COALESCE(interview.candidate_name, '')
          || ' ' || interview.candidate_email) LIKE lower(org::TEXT) || ' %' ||
            replace(replace(replace(lower(input->>'candidate'), E'\\', E'\\\\'),
            '%', E'\\%'), '_', E'\\_') || '%' ESCAPE E'\\')
      AND (NULLIF(input->>'cursorStart', '') IS NULL OR
        (interview.scheduled_start, interview.id) <
          ((input->>'cursorStart')::TIMESTAMPTZ, (input->>'cursorId')::UUID))
      AND CASE COALESCE(NULLIF(input->>'status', ''), 'ALL')
        WHEN 'UPCOMING' THEN interview.scheduled_start >= now()
          AND interview.status NOT IN ('CANCELLED', 'REPORT_READY', 'UNABLE_TO_VERIFY')
        WHEN 'LIVE' THEN interview.status IN ('MONITORING_ACTIVE', 'MONITORING_INTERRUPTED')
        WHEN 'COMPLETED' THEN interview.status IN
          ('MEETING_COMPLETED', 'REPORT_PROCESSING', 'REPORT_READY')
        WHEN 'CONFIRMED' THEN interview.detection_result = 'CONFIRMED'
        WHEN 'NOT_DETECTED' THEN interview.status = 'REPORT_READY'
          AND COALESCE(interview.detection_result, 'NOT_DETECTED') = 'NOT_DETECTED'
        WHEN 'UNABLE_TO_VERIFY' THEN interview.status = 'UNABLE_TO_VERIFY'
        WHEN 'CANCELLED' THEN interview.status = 'CANCELLED'
        ELSE true END
    ORDER BY interview.scheduled_start DESC, interview.id DESC LIMIT page_size + 1), page AS (
    SELECT * FROM filtered ORDER BY scheduled_start DESC, id DESC LIMIT page_size)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'title', title,
    'candidateName', candidate_name, 'candidateEmail', candidate_email,
    'interviewerEmail', organizer_email, 'scheduledStart', scheduled_start,
    'scheduledEnd', scheduled_end, 'status', status, 'protectionStatus', protection_status,
    'meetUrl', google_meet_url, 'classificationReason', classification_reason,
    'consentStatus', consent_status, 'verificationDeliveryStatus', verification_delivery_status,
    'detectionResult', detection_result, 'coveragePercentage', coverage_percentage,
    'reportId', report_id) ORDER BY scheduled_start DESC, id DESC), '[]'::JSONB),
    CASE WHEN (SELECT count(*) FROM filtered) > page_size THEN
      (SELECT scheduled_start FROM page ORDER BY scheduled_start, id LIMIT 1) END,
    CASE WHEN (SELECT count(*) FROM filtered) > page_size THEN
      (SELECT id FROM page ORDER BY scheduled_start, id LIMIT 1) END
  INTO rows, next_start, next_id FROM page;
  RETURN jsonb_build_object('items', rows, 'nextCursor', CASE WHEN next_id IS NULL THEN NULL
    ELSE encode(convert_to(next_start::TEXT || '|' || next_id::TEXT, 'UTF8'), 'base64') END);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR
    numeric_value_out_of_range THEN
  RETURN jsonb_build_object('items', '[]'::JSONB, 'nextCursor', NULL, 'invalid', true);
END $$;
CREATE OR REPLACE FUNCTION authenti8_meeting_detail(input JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID := authenti8_user_organization((input->>'userId')::UUID); result JSONB;
BEGIN
  SELECT jsonb_build_object('interview', jsonb_build_object('id', interview.id,
    'title', interview.title, 'candidateName', interview.candidate_name,
    'candidateEmail', interview.candidate_email, 'interviewerEmail', interview.organizer_email,
    'scheduledStart', interview.scheduled_start, 'scheduledEnd', interview.scheduled_end,
    'status', interview.status, 'detectionResult', interview.detection_result,
    'coveragePercentage', interview.coverage_percentage, 'consentStatus', interview.consent_status),
    'timeline', COALESCE((SELECT jsonb_agg(jsonb_build_object('sequence', event.id,
      'kind', event.kind, 'message', event.message, 'occurredAt', event.occurred_at,
      'integrityHash', event.integrity_hash) ORDER BY event.id)
      FROM recruiter_live_events event WHERE event.interview_id = interview.id), '[]'::JSONB),
    'report', (SELECT report.snapshot || jsonb_build_object('id', report.id,
      'version', report.version, 'generatedAt', report.generated_at)
      FROM reports report WHERE report.interview_id = interview.id
      ORDER BY report.version DESC LIMIT 1)) INTO result
  FROM interviews interview WHERE interview.id = (input->>'interviewId')::UUID
    AND interview.organization_id = org;
  RETURN result;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION authenti8_enqueue_report() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'MEETING_COMPLETED' AND OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO report_generation_jobs(interview_id, available_at)
    VALUES (NEW.id, COALESCE(NEW.monitoring_ended_at, now()) + interval '30 seconds')
    ON CONFLICT (interview_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authenti8_enqueue_report_after_meeting
AFTER UPDATE OF status ON interviews FOR EACH ROW EXECUTE FUNCTION authenti8_enqueue_report();
CREATE OR REPLACE FUNCTION authenti8_generate_report(target UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE interview interviews; session verification_sessions; device candidate_devices;
  snapshot JSONB; generated_report_id UUID; pack_version TEXT; pack_versions JSONB;
  report_version INTEGER; final_coverage NUMERIC;
BEGIN
  SELECT * INTO interview FROM interviews WHERE id = target FOR UPDATE;
  IF interview.id IS NULL THEN RETURN jsonb_build_object('generated', false); END IF;
  SELECT * INTO session FROM verification_sessions WHERE interview_id = target
    ORDER BY created_at DESC, id DESC LIMIT 1;
  final_coverage := authenti8_calculate_monitoring_coverage(session.id,
    COALESCE(session.monitoring_ended_at, interview.scheduled_end));
  UPDATE verification_sessions SET coverage_percentage = final_coverage WHERE id = session.id;
  UPDATE interviews SET coverage_percentage = final_coverage WHERE id = target;
  SELECT * INTO device FROM candidate_devices WHERE verification_session_id = session.id
    ORDER BY enrolled_at DESC LIMIT 1;
  SELECT COALESCE(jsonb_agg(candidate.version ORDER BY candidate.version), '[]'::JSONB)
    INTO pack_versions FROM (SELECT DISTINCT CASE WHEN event_type IN
      ('BROWSER_EXTENSION_MATCH', 'BROWSER_EXTENSION_CHANGED')
      THEN payload->>'rulePackVersion' ELSE rule_pack_version END AS version
      FROM telemetry_events WHERE verification_session_id = session.id) candidate
    WHERE NULLIF(candidate.version, '') IS NOT NULL;
  SELECT CASE WHEN event_type IN ('BROWSER_EXTENSION_MATCH', 'BROWSER_EXTENSION_CHANGED')
      THEN payload->>'rulePackVersion' ELSE rule_pack_version END INTO pack_version
    FROM telemetry_events WHERE verification_session_id = session.id
    ORDER BY event_timestamp DESC, sequence_number DESC LIMIT 1;
  pack_version := COALESCE(NULLIF(pack_version, ''), 'unknown');
  report_version := COALESCE((SELECT max(version) + 1 FROM reports WHERE interview_id = target), 1);
  snapshot := jsonb_build_object('candidate', jsonb_build_object('name', interview.candidate_name,
      'email', interview.candidate_email), 'interviewTitle', interview.title,
    'interviewer', interview.organizer_email, 'scheduledStart', interview.scheduled_start,
    'scheduledEnd', interview.scheduled_end, 'durationSeconds',
      GREATEST(0, EXTRACT(EPOCH FROM COALESCE(session.monitoring_ended_at,
        interview.scheduled_end) - COALESCE(session.monitoring_started_at,
        interview.scheduled_start))::INTEGER),
    'consent', jsonb_build_object('status', interview.consent_status,
      'version', session.consent_version, 'acceptedAt', session.consented_at),
    'device', jsonb_build_object('platform', device.platform,
      'platformVersion', device.platform_version, 'agentVersion', device.agent_version),
    'detectionResult', COALESCE(interview.detection_result, 'NOT_DETECTED'),
    'monitoringCoverage', final_coverage,
    'interruptions', COALESCE((SELECT jsonb_agg(jsonb_build_object('startedAt', started_at,
      'endedAt', ended_at, 'reason', reason) ORDER BY started_at)
      FROM monitoring_interruptions WHERE verification_session_id = session.id), '[]'::JSONB),
    'confirmedIncidents', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', incident.id,
      'ruleKey', rule.rule_key, 'confidence', incident.confidence,
      'occurredAt', event.event_timestamp, 'rulePackVersion', incident.rule_pack_version)
      ORDER BY event.sequence_number)
      FROM detection_incidents incident JOIN detection_rules rule ON rule.id = incident.rule_id
      JOIN telemetry_events event ON event.id = incident.source_event_id
      WHERE incident.verification_session_id = session.id), '[]'::JSONB),
    'timeline', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'message', message,
      'occurredAt', occurred_at, 'integrityHash', integrity_hash) ORDER BY id)
      FROM recruiter_live_events WHERE interview_id = target), '[]'::JSONB),
    'rulePackVersion', pack_version, 'rulePackVersions', pack_versions, 'disclaimer',
      'Not Detected means Authenti8 found no confirmed event in the monitored evidence. It is not proof that cheating was impossible.');
  INSERT INTO reports(interview_id, version, detection_result, monitoring_status,
    coverage_percentage, snapshot, rule_pack_version) VALUES (target, report_version,
    COALESCE(interview.detection_result, 'NOT_DETECTED'), 'COMPLETED',
    final_coverage, snapshot, pack_version)
    RETURNING id INTO generated_report_id;
  UPDATE interviews SET report_id = generated_report_id, updated_at = now() WHERE id = target;
  PERFORM authenti8_transition_interview(target,
    ARRAY['REPORT_PROCESSING'], 'REPORT_READY', 'REPORT_GENERATION_COMPLETED');
  INSERT INTO workspace_notifications(organization_id, interview_id, kind, title, message,
    severity, link_path, idempotency_key) VALUES (interview.organization_id, target,
    'REPORT_READY', 'Integrity report ready', 'The final integrity report is ready to review.',
    'INFO', '/dashboard/meetings/' || target, 'report-ready:' || generated_report_id);
  RETURN jsonb_build_object('generated', true, 'reportId', generated_report_id,
    'version', report_version);
END $$;

CREATE OR REPLACE FUNCTION authenti8_process_reports(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE item RECORD; processed INTEGER := 0;
BEGIN
  UPDATE report_generation_jobs SET status = 'FAILED', lease_until = NULL,
    last_error = COALESCE(last_error, 'Report generation lease expired after maximum attempts'),
    updated_at = now()
    WHERE status = 'PROCESSING' AND lease_until <= now() AND attempts >= 5;
  FOR item IN SELECT interview_id FROM report_generation_jobs
    WHERE status IN ('PENDING', 'FAILED', 'PROCESSING') AND available_at <= now()
      AND attempts < 5
      AND (lease_until IS NULL OR lease_until <= now())
    ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 20 LOOP
    UPDATE report_generation_jobs SET status = 'PROCESSING', attempts = attempts + 1,
      lease_until = now() + interval '1 minute', updated_at = now()
      WHERE interview_id = item.interview_id;
    PERFORM authenti8_transition_interview(item.interview_id,
      ARRAY['MEETING_COMPLETED'], 'REPORT_PROCESSING', 'REPORT_GENERATION_STARTED');
    BEGIN
      PERFORM authenti8_generate_report(item.interview_id);
      UPDATE report_generation_jobs SET status = 'COMPLETED', lease_until = NULL,
        last_error = NULL, updated_at = now() WHERE interview_id = item.interview_id;
      processed := processed + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE report_generation_jobs SET status = 'FAILED', lease_until = NULL,
        available_at = now() + LEAST(300, 5 * power(2, attempts)) * interval '1 second',
        last_error = left(SQLERRM, 500), updated_at = now()
        WHERE interview_id = item.interview_id;
    END;
  END LOOP;
  RETURN jsonb_build_object('processed', processed);
END $$;
CREATE OR REPLACE FUNCTION authenti8_prepare_notification() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.title := CASE NEW.kind
    WHEN 'GOOGLE_REAUTH_REQUIRED' THEN 'Reconnect Google Calendar'
    WHEN 'SUBSCRIPTION_PAYMENT_FAILED' THEN 'Subscription payment failed'
    WHEN 'LOW_CREDITS' THEN 'Interview credits are running low'
    WHEN 'CONSENT_DECLINED' THEN 'Candidate declined consent'
    WHEN 'VERIFICATION_DELIVERY_FAILED' THEN 'Candidate verification could not start'
    WHEN 'MONITORING_INTERRUPTED' THEN 'Interview monitoring interrupted'
    WHEN 'CONFIRMED_DETECTION' THEN 'Prohibited assistance confirmed'
    WHEN 'REPORT_READY' THEN 'Integrity report ready'
    ELSE NEW.title END;
  NEW.severity := CASE WHEN NEW.kind = 'CONFIRMED_DETECTION' THEN 'CRITICAL'
    WHEN NEW.kind IN ('GOOGLE_REAUTH_REQUIRED', 'SUBSCRIPTION_PAYMENT_FAILED', 'LOW_CREDITS',
      'CONSENT_DECLINED', 'VERIFICATION_DELIVERY_FAILED', 'MONITORING_INTERRUPTED')
      THEN 'WARNING' ELSE NEW.severity END;
  NEW.link_path := COALESCE(NEW.link_path, CASE WHEN NEW.interview_id IS NOT NULL
    THEN '/dashboard/meetings/' || NEW.interview_id ELSE '/dashboard' END);
  RETURN NEW;
END $$;
CREATE TRIGGER authenti8_prepare_notification_before_insert
BEFORE INSERT ON workspace_notifications FOR EACH ROW
EXECUTE FUNCTION authenti8_prepare_notification();
CREATE OR REPLACE FUNCTION authenti8_notification_fanout() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.severity IN ('WARNING', 'CRITICAL') THEN
    INSERT INTO notification_email_outbox(notification_id, recipient)
    SELECT NEW.id, user_account.email FROM organization_members member
    JOIN users user_account ON user_account.id = member.user_id
    WHERE member.organization_id = NEW.organization_id
      AND user_account.status = 'ACTIVE'
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authenti8_notification_fanout_after_insert
AFTER INSERT ON workspace_notifications FOR EACH ROW
EXECUTE FUNCTION authenti8_notification_fanout();

CREATE OR REPLACE FUNCTION authenti8_live_detection_notification() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID;
BEGIN
  IF NEW.kind <> 'CONFIRMED_DETECTION' THEN RETURN NEW; END IF;
  SELECT organization_id INTO org FROM interviews WHERE id = NEW.interview_id;
  INSERT INTO workspace_notifications(organization_id, interview_id, kind, message,
    idempotency_key) VALUES (org, NEW.interview_id, 'CONFIRMED_DETECTION', NEW.message,
    'confirmed-detection:' || NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER authenti8_live_detection_notification_after_insert
AFTER INSERT ON recruiter_live_events FOR EACH ROW
EXECUTE FUNCTION authenti8_live_detection_notification();

CREATE OR REPLACE FUNCTION authenti8_account_notification() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME = 'google_integrations' AND NEW.status = 'REAUTH_REQUIRED'
      AND OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO workspace_notifications(organization_id, kind, message, idempotency_key)
    VALUES (NEW.organization_id, 'GOOGLE_REAUTH_REQUIRED',
      'Google Calendar authorization expired. Reconnect the integration.',
      'google-reauth:' || NEW.id || ':' || NEW.updated_at::TEXT) ON CONFLICT DO NOTHING;
  ELSIF TG_TABLE_NAME = 'subscriptions' AND NEW.status = 'PAST_DUE'
      AND OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO workspace_notifications(organization_id, kind, message, idempotency_key)
    VALUES (NEW.organization_id, 'SUBSCRIPTION_PAYMENT_FAILED',
      'The subscription payment failed. Update the payment method to restore service.',
      'subscription-past-due:' || NEW.id || ':' || NEW.updated_at::TEXT) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authenti8_google_reauth_notification
AFTER UPDATE OF status ON google_integrations FOR EACH ROW
EXECUTE FUNCTION authenti8_account_notification();
CREATE TRIGGER authenti8_payment_failure_notification
AFTER UPDATE OF status ON subscriptions FOR EACH ROW
EXECUTE FUNCTION authenti8_account_notification();

CREATE OR REPLACE FUNCTION authenti8_low_credit_notification() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE remaining INTEGER;
BEGIN
  IF NEW.amount >= 0 THEN RETURN NEW; END IF;
  remaining := authenti8_available_credits(NEW.organization_id);
  IF remaining <= 2 AND remaining - NEW.amount > 2 THEN
    INSERT INTO workspace_notifications(organization_id, kind, message, idempotency_key)
    VALUES (NEW.organization_id, 'LOW_CREDITS',
      'Only ' || remaining || ' protected interview credits remain.',
      'low-credits:' || NEW.organization_id || ':' ||
        COALESCE(authenti8_period_key(NEW.organization_id), 'unknown')) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authenti8_low_credit_notification_after_insert
AFTER INSERT ON credit_transactions FOR EACH ROW
EXECUTE FUNCTION authenti8_low_credit_notification();

CREATE OR REPLACE FUNCTION authenti8_claim_notification_email() RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result JSONB;
BEGIN
  UPDATE notification_email_outbox SET status = 'FAILED', lease_until = NULL,
    last_error = COALESCE(last_error, 'Delivery lease expired after maximum attempts')
    WHERE status = 'PROCESSING' AND lease_until <= now() AND attempts >= 5;
  WITH selected AS (SELECT outbox.id FROM notification_email_outbox outbox
    WHERE (outbox.status = 'PENDING' AND outbox.available_at <= now())
      OR (outbox.status = 'PROCESSING' AND outbox.lease_until <= now()
        AND outbox.attempts < 5)
    ORDER BY outbox.created_at FOR UPDATE SKIP LOCKED LIMIT 1), claimed AS (
    UPDATE notification_email_outbox outbox SET status = 'PROCESSING',
      attempts = attempts + 1, lease_until = now() + interval '30 seconds'
    FROM selected WHERE outbox.id = selected.id RETURNING outbox.*)
  SELECT jsonb_build_object('id', claimed.id, 'attempts', claimed.attempts,
    'recipient', claimed.recipient, 'title', notice.title, 'message', notice.message,
    'linkPath', notice.link_path) INTO result FROM claimed
    JOIN workspace_notifications notice ON notice.id = claimed.notification_id;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION authenti8_renew_notification_email(input JSONB) RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE notification_email_outbox SET lease_until = now() + interval '30 seconds'
  WHERE id = (input->>'id')::UUID AND status = 'PROCESSING' AND attempts = (input->>'attempts')::INTEGER
  RETURNING jsonb_build_object('renewed', true)
$$;
CREATE OR REPLACE FUNCTION authenti8_complete_notification_email(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE notification_email_outbox SET status = 'SENT', lease_until = NULL
  WHERE id = (input->>'id')::UUID AND status = 'PROCESSING'
    AND attempts = (input->>'attempts')::INTEGER
  RETURNING jsonb_build_object('completed', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_fail_notification_email(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE notification_email_outbox SET status = CASE WHEN attempts >= 5
      THEN 'FAILED' ELSE 'PENDING' END, lease_until = NULL,
    available_at = now() + LEAST(300, 5 * power(2, attempts)) * interval '1 second',
    last_error = left(input->>'error', 500)
  WHERE id = (input->>'id')::UUID AND status = 'PROCESSING'
    AND attempts = (input->>'attempts')::INTEGER
  RETURNING jsonb_build_object('failed', true, 'terminal', status = 'FAILED')
$$;

CREATE OR REPLACE FUNCTION authenti8_notifications(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', notice.id, 'kind', notice.kind,
    'title', notice.title, 'message', notice.message, 'severity', notice.severity,
    'linkPath', notice.link_path, 'readAt', notice.read_at, 'createdAt', notice.created_at)
    ORDER BY notice.created_at DESC), '[]'::JSONB) FROM (
    SELECT item.* FROM workspace_notifications item
    JOIN organization_members member ON member.organization_id = item.organization_id
    WHERE member.user_id = (input->>'userId')::UUID
    ORDER BY item.created_at DESC LIMIT 100) notice
$$;

CREATE OR REPLACE FUNCTION authenti8_billing_history(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH org AS (SELECT authenti8_user_organization((input->>'userId')::UUID) AS id)
  SELECT jsonb_build_object('transactions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id', transaction.id, 'amount', transaction.amount, 'kind', transaction.kind,
    'referenceId', transaction.reference_id, 'createdAt', transaction.created_at)
    ORDER BY transaction.created_at DESC) FROM (SELECT item.* FROM credit_transactions item, org
    WHERE item.organization_id = org.id ORDER BY item.created_at DESC LIMIT 100) transaction),
    '[]'::JSONB),
    'payments', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', payment.payment_id,
      'purpose', payment.purpose, 'quantity', payment.quantity, 'amountMinor', payment.amount_minor,
      'currency', payment.currency, 'createdAt', payment.event_occurred_at)
      ORDER BY payment.event_occurred_at DESC) FROM (SELECT item.*
      FROM billing_provider_payments item, org WHERE item.organization_id = org.id
      ORDER BY item.event_occurred_at DESC LIMIT 100) payment), '[]'::JSONB))
$$;

CREATE OR REPLACE FUNCTION authenti8_billing_summary(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID; plan TEXT; state TEXT; allowance INTEGER; balance INTEGER;
  used INTEGER; included_used INTEGER; scheduled_cancel BOOLEAN;
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
      ('ALLOWANCE_CONSUMED', 'EXTRA_CONSUMED')), 0),
    COALESCE(-sum(amount) FILTER (WHERE kind = 'ALLOWANCE_CONSUMED'), 0)
  INTO used, included_used FROM credit_transactions WHERE organization_id = org
    AND created_at >= authenti8_period_start(org);
  allowance := authenti8_allowance(plan);
  RETURN jsonb_build_object('plan', plan, 'status', COALESCE(state, 'ACTIVE'),
    'allowance', allowance, 'balance', balance, 'used', used, 'includedUsed', included_used,
    'periodStart', authenti8_period_start(org), 'periodEnd', authenti8_period_end(org),
    'cancelAtPeriodEnd', COALESCE(scheduled_cancel, false));
END $$;
CREATE OR REPLACE FUNCTION authenti8_billing_payment_context(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('paymentId', payment.payment_id)
  FROM billing_provider_payments payment
  JOIN organization_members member ON member.organization_id = payment.organization_id
  WHERE member.user_id = (input->>'userId')::UUID
    AND member.role IN ('OWNER', 'ADMIN')
    AND payment.payment_id = input->>'paymentId'
$$;

REVOKE ALL ON FUNCTION authenti8_meetings_page(JSONB), authenti8_meeting_detail(JSONB),
  authenti8_generate_report(UUID), authenti8_process_reports(JSONB),
  authenti8_notifications(JSONB), authenti8_billing_history(JSONB),
  authenti8_billing_payment_context(JSONB),
  authenti8_claim_notification_email(), authenti8_renew_notification_email(JSONB), authenti8_complete_notification_email(JSONB),
  authenti8_fail_notification_email(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_meetings_page(JSONB), authenti8_meeting_detail(JSONB),
  authenti8_generate_report(UUID), authenti8_process_reports(JSONB),
  authenti8_notifications(JSONB), authenti8_billing_history(JSONB),
  authenti8_billing_payment_context(JSONB),
  authenti8_claim_notification_email(), authenti8_renew_notification_email(JSONB), authenti8_complete_notification_email(JSONB),
  authenti8_fail_notification_email(JSONB) TO service_role;

INSERT INTO schema_migrations(version) VALUES ('038_meetings_reports_notifications')
  ON CONFLICT DO NOTHING;
COMMIT;
