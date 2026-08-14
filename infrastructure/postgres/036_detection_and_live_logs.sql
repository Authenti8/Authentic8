BEGIN;

ALTER TABLE detection_rules
  ADD COLUMN status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'APPROVED', 'PUBLISHED', 'DISABLED')),
  ADD COLUMN approved_at TIMESTAMPTZ,
  ADD COLUMN disabled_at TIMESTAMPTZ,
  ADD CONSTRAINT detection_rules_supporting_signals_array
    CHECK (jsonb_typeof(required_supporting_signals) = 'array');

CREATE TABLE detection_rule_packs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL CHECK (platform IN ('WINDOWS', 'MACOS', 'CHROME')),
  version TEXT NOT NULL,
  rules JSONB NOT NULL,
  signed_payload JSONB NOT NULL,
  signature TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  published_by UUID NOT NULL REFERENCES users(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ,
  UNIQUE (platform, version),
  CHECK (jsonb_typeof(rules) = 'array'),
  CHECK (jsonb_typeof(signed_payload) = 'object'),
  CHECK (expires_at > published_at)
);
CREATE UNIQUE INDEX detection_rule_packs_active_idx ON detection_rule_packs(platform)
  WHERE disabled_at IS NULL;
ALTER TABLE detection_rule_packs ENABLE ROW LEVEL SECURITY;

CREATE TABLE detection_rule_operators (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE detection_rule_operators ENABLE ROW LEVEL SECURITY;

ALTER TABLE detection_incidents
  ADD COLUMN rule_pack_version TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN confidence TEXT NOT NULL DEFAULT 'HIGH'
    CHECK (confidence IN ('HIGH', 'MEDIUM'));
CREATE UNIQUE INDEX detection_incidents_source_rule_idx
  ON detection_incidents(source_event_id, rule_id);

CREATE TABLE recruiter_live_events (
  id BIGSERIAL PRIMARY KEY,
  interview_id UUID NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  source_event_id UUID REFERENCES telemetry_events(id) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK (source_kind IN
    ('TELEMETRY', 'INTERVIEW_LIFECYCLE', 'MONITORING_INTERRUPTION')),
  source_reference TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('WAITING_FOR_CANDIDATE', 'CONSENT_PENDING',
    'DEVICE_CONNECTING', 'MONITORING_ACTIVE', 'CONFIRMED_DETECTION',
    'MONITORING_INTERRUPTED', 'MONITORING_RESUMED', 'MEETING_COMPLETED')),
  message TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX recruiter_live_events_cursor_idx ON recruiter_live_events(interview_id, id);
ALTER TABLE recruiter_live_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE recruiter_extension_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  authorization_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (authorization_expires_at >= expires_at)
);
CREATE INDEX recruiter_extension_tokens_lookup_idx
  ON recruiter_extension_tokens(token_hash, expires_at) WHERE revoked_at IS NULL;
ALTER TABLE recruiter_extension_tokens ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION authenti8_publish_rule_pack(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; selected_platform TEXT := input->>'platform';
  payload JSONB := input->'payload'; pack_version TEXT; approved_count INTEGER;
  supplied_count INTEGER; expiry TIMESTAMPTZ;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM detection_rule_operators WHERE user_id = actor) THEN
    RETURN jsonb_build_object('published', false, 'reason', 'NOT_AUTHORIZED');
  END IF;
  pack_version := payload->>'version';
  IF selected_platform NOT IN ('WINDOWS', 'MACOS', 'CHROME') OR pack_version IS NULL
    OR jsonb_typeof(payload) <> 'object' OR jsonb_typeof(payload->'rules') <> 'array'
    OR NULLIF(payload->>'expiresAt', '') IS NULL
    OR NULLIF(input->>'signature', '') IS NULL OR jsonb_typeof(input->'ruleIds') <> 'array'
    OR jsonb_array_length(input->'ruleIds') = 0 THEN
    RETURN jsonb_build_object('published', false, 'reason', 'INVALID_PACK');
  END IF;
  expiry := (payload->>'expiresAt')::TIMESTAMPTZ;
  IF expiry <= now() THEN
    RETURN jsonb_build_object('published', false, 'reason', 'INVALID_PACK');
  END IF;
  supplied_count := jsonb_array_length(input->'ruleIds');
  IF jsonb_array_length(payload->'rules') <> supplied_count THEN
    RETURN jsonb_build_object('published', false, 'reason', 'INVALID_PACK');
  END IF;
  SELECT count(DISTINCT rule.id) INTO approved_count FROM detection_rules rule
    JOIN jsonb_array_elements(payload->'rules') published
      ON published = rule.match_condition || jsonb_build_object('key', rule.rule_key,
        'family', rule.product_family, 'version', rule.version, 'enabled', rule.enabled)
    WHERE rule.id IN (SELECT value::UUID FROM jsonb_array_elements_text(input->'ruleIds'))
      AND rule.platform = selected_platform AND rule.status = 'APPROVED'
      AND rule.reviewed_by IS NOT NULL AND rule.reviewed_by <> rule.created_by AND rule.enabled
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(rule.required_supporting_signals) signal
        WHERE jsonb_typeof(signal) <> 'string'
          OR (signal #>> '{}') !~ '^[A-Za-z0-9._-]{1,100}$');
  IF approved_count <> supplied_count THEN
    RETURN jsonb_build_object('published', false, 'reason', 'UNAPPROVED_RULE');
  END IF;
  UPDATE detection_rule_packs SET disabled_at = now()
    WHERE platform = selected_platform AND disabled_at IS NULL;
  INSERT INTO detection_rule_packs(platform, version, rules, signed_payload, signature,
    expires_at, published_by) VALUES (selected_platform, pack_version, payload->'rules',
    payload, input->>'signature', expiry, actor);
  UPDATE detection_rules SET status = 'PUBLISHED'
    WHERE id IN (SELECT value::UUID FROM jsonb_array_elements_text(input->'ruleIds'));
  RETURN jsonb_build_object('published', true, 'version', pack_version);
EXCEPTION WHEN unique_violation OR check_violation OR not_null_violation
  OR invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
  RETURN jsonb_build_object('published', false, 'reason', 'INVALID_PACK');
END $$;

CREATE OR REPLACE FUNCTION authenti8_approve_detection_rule(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM detection_rule_operators
      WHERE user_id = (input->>'userId')::UUID) THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'NOT_AUTHORIZED');
  END IF;
  UPDATE detection_rules SET status = 'APPROVED', enabled = true,
    reviewed_by = (input->>'userId')::UUID, approved_at = now()
  WHERE id = (input->>'ruleId')::UUID AND status = 'DRAFT'
    AND created_by IS DISTINCT FROM (input->>'userId')::UUID
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(required_supporting_signals) signal
      WHERE jsonb_typeof(signal) <> 'string'
        OR (signal #>> '{}') !~ '^[A-Za-z0-9._-]{1,100}$');
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN jsonb_build_object('approved', changed = 1,
    'reason', CASE WHEN changed = 1 THEN NULL ELSE 'REVIEW_REQUIRED' END);
END $$;

CREATE OR REPLACE FUNCTION authenti8_active_rule_pack(input JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE pack detection_rule_packs;
BEGIN
  SELECT * INTO pack FROM detection_rule_packs WHERE platform = input->>'platform'
    AND disabled_at IS NULL AND expires_at > now() ORDER BY published_at DESC LIMIT 1;
  IF pack.id IS NULL THEN
    RETURN jsonb_build_object('available', false, 'fallbackAllowed', NOT EXISTS (
      SELECT 1 FROM detection_rule_packs WHERE platform = input->>'platform'));
  END IF;
  RETURN pack.signed_payload || jsonb_build_object('available', true, 'signature', pack.signature);
END $$;

CREATE OR REPLACE FUNCTION authenti8_disable_detection_rule(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM detection_rule_operators
      WHERE user_id = (input->>'userId')::UUID) THEN
    RETURN jsonb_build_object('disabled', false, 'reason', 'NOT_AUTHORIZED');
  END IF;
  UPDATE detection_rules SET enabled = false, status = 'DISABLED', disabled_at = now()
    WHERE id = (input->>'ruleId')::UUID AND status IN ('APPROVED', 'PUBLISHED');
  GET DIAGNOSTICS changed = ROW_COUNT;
  UPDATE detection_rule_packs pack SET disabled_at = now() WHERE pack.disabled_at IS NULL
    AND EXISTS (SELECT 1 FROM detection_rules rule,
      jsonb_array_elements(pack.rules) published WHERE rule.id = (input->>'ruleId')::UUID
      AND published->>'key' = rule.rule_key
      AND (published->>'version')::INTEGER = rule.version);
  RETURN jsonb_build_object('disabled', changed = 1);
END $$;

CREATE OR REPLACE FUNCTION authenti8_recruiter_meeting(input JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE result JSONB;
BEGIN
  SELECT jsonb_build_object('protected', true, 'interviewId', interview.id,
    'candidateName', interview.candidate_name, 'status', interview.status,
    'platform', device.platform, 'coveragePercentage', session.coverage_percentage,
    'detectionResult', COALESCE(interview.detection_result, 'NOT_DETECTED')) INTO result
  FROM interviews interview
  JOIN organization_members member ON member.organization_id = interview.organization_id
  LEFT JOIN LATERAL (SELECT candidate.* FROM verification_sessions candidate
    WHERE candidate.interview_id = interview.id ORDER BY candidate.created_at DESC, candidate.id DESC
    LIMIT 1) session ON true
  LEFT JOIN candidate_devices device ON device.verification_session_id = session.id
    AND device.revoked_at IS NULL
  WHERE interview.google_meet_code = lower(input->>'meetCode')
    AND interview.organization_id = (input->>'organizationId')::UUID
    AND member.user_id = (input->>'userId')::UUID
    AND interview.status NOT IN ('EXCLUDED', 'CANCELLED')
    AND now() BETWEEN interview.scheduled_start - interval '15 minutes'
      AND interview.scheduled_end + interval '30 minutes'
  ORDER BY interview.scheduled_start DESC LIMIT 1;
  RETURN COALESCE(result, jsonb_build_object('protected', false));
END $$;

CREATE OR REPLACE FUNCTION authenti8_issue_recruiter_token(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID := (input->>'organizationId')::UUID; authorization_end TIMESTAMPTZ;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organization_members WHERE organization_id = org
      AND user_id = (input->>'userId')::UUID) THEN
    RETURN jsonb_build_object('issued', false);
  END IF;
  DELETE FROM recruiter_extension_tokens WHERE user_id = (input->>'userId')::UUID
    AND expires_at <= now();
  authorization_end := LEAST((input->>'authorizationExpiresAt')::TIMESTAMPTZ,
    now() + interval '8 hours');
  IF authorization_end <= now() THEN RETURN jsonb_build_object('issued', false); END IF;
  INSERT INTO recruiter_extension_tokens(token_hash, organization_id, user_id, expires_at,
    authorization_expires_at)
  VALUES (input->>'tokenHash', org, (input->>'userId')::UUID,
    LEAST((input->>'expiresAt')::TIMESTAMPTZ, now() + interval '15 minutes', authorization_end),
    authorization_end);
  RETURN jsonb_build_object('issued', true, 'organizationId', org);
END $$;

CREATE OR REPLACE FUNCTION authenti8_rotate_recruiter_token(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE current_token recruiter_extension_tokens; replacement_expiry TIMESTAMPTZ;
BEGIN
  SELECT * INTO current_token FROM recruiter_extension_tokens
    WHERE token_hash = input->>'tokenHash' AND revoked_at IS NULL
      AND authorization_expires_at > now() FOR UPDATE;
  IF current_token.id IS NULL OR NOT EXISTS (SELECT 1 FROM organization_members
      WHERE organization_id = current_token.organization_id
        AND user_id = current_token.user_id) THEN
    RETURN jsonb_build_object('rotated', false);
  END IF;
  replacement_expiry := LEAST((input->>'expiresAt')::TIMESTAMPTZ,
    now() + interval '15 minutes', current_token.authorization_expires_at);
  UPDATE recruiter_extension_tokens SET revoked_at = now() WHERE id = current_token.id;
  INSERT INTO recruiter_extension_tokens(token_hash, organization_id, user_id, expires_at,
    authorization_expires_at) VALUES (input->>'replacementHash', current_token.organization_id,
    current_token.user_id, replacement_expiry, current_token.authorization_expires_at);
  RETURN jsonb_build_object('rotated', true, 'expiresAt', replacement_expiry,
    'authorizationExpiresAt', current_token.authorization_expires_at);
END $$;

CREATE OR REPLACE FUNCTION authenti8_resolve_recruiter_token(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE token recruiter_extension_tokens;
BEGIN
  SELECT * INTO token FROM recruiter_extension_tokens WHERE token_hash = input->>'tokenHash'
    AND revoked_at IS NULL AND expires_at > now();
  IF token.id IS NULL THEN RETURN jsonb_build_object('valid', false); END IF;
  RETURN jsonb_build_object('valid', true, 'userId', token.user_id,
    'organizationId', token.organization_id, 'expiresAt', token.expires_at);
END $$;

CREATE OR REPLACE FUNCTION authenti8_recruiter_logs(input JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE allowed BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM interviews interview JOIN organization_members member
    ON member.organization_id = interview.organization_id
    WHERE interview.id = (input->>'interviewId')::UUID
      AND interview.organization_id = (input->>'organizationId')::UUID
      AND member.user_id = (input->>'userId')::UUID
      AND now() BETWEEN interview.scheduled_start - interval '15 minutes'
        AND interview.scheduled_end + interval '30 minutes') INTO allowed;
  IF NOT allowed THEN RETURN jsonb_build_object('authorized', false, 'events', '[]'::JSONB); END IF;
  RETURN jsonb_build_object('authorized', true, 'events', COALESCE((SELECT jsonb_agg(row_data)
    FROM (SELECT id AS sequence, kind, message, occurred_at AS "occurredAt", metadata
      FROM recruiter_live_events WHERE interview_id = (input->>'interviewId')::UUID
        AND id > COALESCE((input->>'after')::BIGINT, 0) ORDER BY id LIMIT 500) row_data), '[]'::JSONB));
END $$;

CREATE OR REPLACE FUNCTION authenti8_evaluate_detection_event() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE matched detection_rules; interview UUID; is_confirmed BOOLEAN := false;
  evaluated_pack_version TEXT;
BEGIN
  IF NEW.event_type NOT IN ('HIDDEN_OVERLAY_MATCH', 'BROWSER_EXTENSION_MATCH',
      'BROWSER_EXTENSION_CHANGED',
      'KNOWN_PROCESS_MATCH', 'AUDIO_ROUTE_CHANGED') THEN RETURN NEW; END IF;
  evaluated_pack_version := CASE WHEN NEW.event_type IN
      ('BROWSER_EXTENSION_MATCH', 'BROWSER_EXTENSION_CHANGED')
    THEN NEW.payload->>'rulePackVersion' ELSE NEW.rule_pack_version END;
  IF NULLIF(evaluated_pack_version, '') IS NULL THEN RETURN NEW; END IF;
  SELECT rule.* INTO matched FROM detection_rules rule
    JOIN detection_rule_packs pack ON pack.platform = rule.platform
      AND pack.version = evaluated_pack_version AND pack.disabled_at IS NULL
      AND NEW.event_timestamp <= pack.expires_at
  WHERE rule.rule_key = NEW.payload->>'ruleKey'
    AND rule.version = COALESCE((NEW.payload->>'ruleVersion')::INTEGER, 1)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(pack.rules) packed
      WHERE packed->>'key' = rule.rule_key
        AND (packed->>'version')::INTEGER = rule.version
        AND (NEW.event_type NOT IN ('BROWSER_EXTENSION_MATCH', 'BROWSER_EXTENSION_CHANGED')
          OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(packed->'extensionIds', '[]'::JSONB)) id
          WHERE id.value = NEW.payload->>'extensionId')))
    AND rule.enabled AND rule.status = 'PUBLISHED' LIMIT 1;
  IF matched.id IS NULL THEN RETURN NEW; END IF;
  is_confirmed := matched.confidence = 'HIGH' AND (
    (NEW.event_type IN ('BROWSER_EXTENSION_MATCH', 'BROWSER_EXTENSION_CHANGED')
      AND NEW.payload->>'enabled' = 'true')
    OR (NEW.event_type IN ('HIDDEN_OVERLAY_MATCH', 'KNOWN_PROCESS_MATCH')
      AND CASE WHEN jsonb_typeof(NEW.payload->'identityEvidence') = 'array'
        THEN jsonb_array_length(NEW.payload->'identityEvidence') ELSE 0 END > 0
      AND CASE WHEN jsonb_typeof(NEW.payload->'activeUseEvidence') = 'array'
        THEN jsonb_array_length(NEW.payload->'activeUseEvidence') ELSE 0 END > 0));
  IF matched.confidence = 'MEDIUM' AND NOT (
      (NEW.event_type IN ('BROWSER_EXTENSION_MATCH', 'BROWSER_EXTENSION_CHANGED')
        AND NEW.payload->>'enabled' = 'true')
      OR (NEW.event_type IN ('HIDDEN_OVERLAY_MATCH', 'KNOWN_PROCESS_MATCH')
        AND CASE WHEN jsonb_typeof(NEW.payload->'identityEvidence') = 'array'
          THEN jsonb_array_length(NEW.payload->'identityEvidence') ELSE 0 END > 0)
      OR (NEW.event_type = 'AUDIO_ROUTE_CHANGED'
        AND NULLIF(NEW.payload->>'endpointIdHash', '') IS NOT NULL)) THEN RETURN NEW; END IF;
  IF matched.confidence = 'MEDIUM' AND jsonb_array_length(matched.required_supporting_signals) > 0 THEN
    SELECT NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(matched.required_supporting_signals) required
      WHERE NOT EXISTS (SELECT 1 FROM telemetry_events signal
        JOIN detection_rules supporting ON supporting.rule_key = signal.payload->>'ruleKey'
          AND supporting.version = COALESCE((signal.payload->>'ruleVersion')::INTEGER, 1)
        JOIN detection_rule_packs supporting_pack ON supporting_pack.platform = supporting.platform
          AND supporting_pack.version = CASE WHEN signal.event_type IN
            ('BROWSER_EXTENSION_MATCH', 'BROWSER_EXTENSION_CHANGED')
            THEN signal.payload->>'rulePackVersion' ELSE signal.rule_pack_version END
          AND supporting_pack.disabled_at IS NULL
          AND signal.event_timestamp <= supporting_pack.expires_at
        WHERE signal.verification_session_id = NEW.verification_session_id
          AND signal.id <> NEW.id
          AND supporting.rule_key = required.value AND supporting.confidence = 'MEDIUM'
          AND supporting.enabled AND supporting.status = 'PUBLISHED'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(supporting_pack.rules) packed
            WHERE packed->>'key' = supporting.rule_key
              AND (packed->>'version')::INTEGER = supporting.version
              AND (signal.event_type NOT IN ('BROWSER_EXTENSION_MATCH',
                'BROWSER_EXTENSION_CHANGED') OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                  COALESCE(packed->'extensionIds', '[]'::JSONB)) extension_id
                WHERE extension_id.value = signal.payload->>'extensionId')))
          AND signal.event_type IN ('KNOWN_PROCESS_MATCH', 'AUDIO_ROUTE_CHANGED',
            'HIDDEN_OVERLAY_MATCH', 'BROWSER_EXTENSION_MATCH', 'BROWSER_EXTENSION_CHANGED')
          AND (CASE WHEN jsonb_typeof(signal.payload->'identityEvidence') = 'array'
              THEN jsonb_array_length(signal.payload->'identityEvidence') ELSE 0 END > 0
            OR (NULLIF(signal.payload->>'extensionId', '') IS NOT NULL
              AND signal.payload->>'enabled' = 'true')
            OR NULLIF(signal.payload->>'endpointIdHash', '') IS NOT NULL))) INTO is_confirmed;
  END IF;
  IF NOT is_confirmed THEN RETURN NEW; END IF;
  INSERT INTO detection_incidents(verification_session_id, rule_id, source_event_id,
    result, evidence_summary, rule_pack_version, confidence)
  VALUES (NEW.verification_session_id, matched.id, NEW.id, 'CONFIRMED',
    jsonb_build_object('eventType', NEW.event_type, 'technicalEvidence', NEW.payload),
    evaluated_pack_version, matched.confidence) ON CONFLICT DO NOTHING;
  SELECT interview_id INTO interview FROM verification_sessions
    WHERE id = NEW.verification_session_id;
  UPDATE interviews SET detection_result = 'CONFIRMED', updated_at = now() WHERE id = interview;
  INSERT INTO recruiter_live_events(interview_id, source_event_id, source_kind, source_reference,
    kind, message, occurred_at, metadata, idempotency_key) VALUES (interview, NEW.id,
    'TELEMETRY', NEW.id::TEXT,
    'CONFIRMED_DETECTION', 'Prohibited AI assistance confirmed', NEW.event_timestamp,
    jsonb_build_object('rulePackVersion', evaluated_pack_version),
    'detection:' || NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN RETURN NEW;
END $$;
CREATE TRIGGER authenti8_telemetry_detection_decision AFTER INSERT ON telemetry_events
  FOR EACH ROW EXECUTE FUNCTION authenti8_evaluate_detection_event();

CREATE OR REPLACE FUNCTION authenti8_interview_recruiter_log() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE log_kind TEXT; log_message TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN RETURN NEW; END IF;
  SELECT CASE NEW.status WHEN 'WAITING_FOR_CANDIDATE' THEN 'WAITING_FOR_CANDIDATE'
    WHEN 'CONSENT_PENDING' THEN 'CONSENT_PENDING' WHEN 'DEVICE_CONNECTING' THEN 'DEVICE_CONNECTING'
    WHEN 'MONITORING_ACTIVE' THEN 'MONITORING_ACTIVE'
    WHEN 'MEETING_COMPLETED' THEN 'MEETING_COMPLETED' END INTO log_kind;
  IF log_kind IS NULL THEN RETURN NEW; END IF;
  log_message := CASE log_kind WHEN 'WAITING_FOR_CANDIDATE' THEN 'Waiting for candidate'
    WHEN 'CONSENT_PENDING' THEN 'Candidate consent pending'
    WHEN 'DEVICE_CONNECTING' THEN 'Candidate device connecting'
    WHEN 'MONITORING_ACTIVE' THEN 'Monitoring active' ELSE 'Meeting completed' END;
  INSERT INTO recruiter_live_events(interview_id, source_kind, source_reference, kind, message,
    occurred_at, idempotency_key) VALUES (NEW.id, 'INTERVIEW_LIFECYCLE',
    NEW.id || ':' || log_kind, log_kind, log_message, now(),
    'lifecycle:' || NEW.id || ':' || log_kind)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER authenti8_interview_live_log AFTER INSERT OR UPDATE OF status ON interviews
  FOR EACH ROW EXECUTE FUNCTION authenti8_interview_recruiter_log();

CREATE OR REPLACE FUNCTION authenti8_interruption_recruiter_log() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE interview UUID; log_kind TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN log_kind := 'MONITORING_INTERRUPTED';
  ELSIF OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL THEN log_kind := 'MONITORING_RESUMED';
  ELSE RETURN NEW; END IF;
  SELECT interview_id INTO interview FROM verification_sessions
    WHERE id = NEW.verification_session_id;
  INSERT INTO recruiter_live_events(interview_id, source_kind, source_reference, kind, message,
    occurred_at, idempotency_key) VALUES (interview, 'MONITORING_INTERRUPTION', NEW.id::TEXT,
    log_kind, CASE WHEN log_kind = 'MONITORING_INTERRUPTED'
    THEN 'Monitoring interrupted' ELSE 'Monitoring resumed' END,
    COALESCE(NEW.ended_at, NEW.started_at), 'interruption:' || NEW.id || ':' || log_kind)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER authenti8_interruption_live_log AFTER INSERT OR UPDATE OF ended_at
  ON monitoring_interruptions FOR EACH ROW EXECUTE FUNCTION authenti8_interruption_recruiter_log();

CREATE OR REPLACE FUNCTION authenti8_close_interruption_on_heartbeat() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE interruption monitoring_interruptions; org UUID; interview UUID;
BEGIN
  UPDATE monitoring_interruptions SET ended_at = NEW.received_at
    WHERE verification_session_id = NEW.verification_session_id AND ended_at IS NULL
      AND reason = 'HEARTBEAT_MISSED' RETURNING * INTO interruption;
  IF interruption.id IS NULL THEN RETURN NEW; END IF;
  UPDATE verification_sessions SET monitoring_health = 'ACTIVE'
    WHERE id = NEW.verification_session_id AND status = 'MONITORING_ACTIVE';
  SELECT candidate.interview_id, source.organization_id INTO interview, org
    FROM verification_sessions candidate JOIN interviews source ON source.id = candidate.interview_id
    WHERE candidate.id = NEW.verification_session_id;
  INSERT INTO workspace_notifications(organization_id, interview_id, kind, message, idempotency_key)
  VALUES (org, interview, 'MONITORING_RESUMED', 'Candidate device monitoring resumed.',
    'monitoring-resumed:' || interruption.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION authenti8_finish_on_stop_event() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE last_seen TIMESTAMPTZ;
BEGIN
  IF NEW.event_type = 'MONITORING_STOPPED' THEN
    PERFORM authenti8_finish_monitoring(jsonb_build_object(
      'verificationSessionId', NEW.verification_session_id, 'endedAt', NEW.event_timestamp,
      'reason', COALESCE(NEW.payload->>'reason', 'AGENT_MONITORING_STOPPED')));
  ELSIF NEW.event_type = 'MONITORING_STARTED' THEN
    UPDATE verification_sessions SET monitoring_health = 'ACTIVE'
      WHERE id = NEW.verification_session_id AND status = 'MONITORING_ACTIVE';
  ELSIF (NEW.event_type = 'BROWSER_PROFILE_HEALTH'
      AND NEW.payload->>'activeProfileVerified' = 'false')
      OR (NEW.event_type = 'PERMISSION_CHANGED' AND NEW.payload->>'sensor' = 'BROWSER'
        AND NEW.payload->>'available' = 'false') THEN
    UPDATE monitoring_interruptions SET reason =
      COALESCE(NULLIF(NEW.payload->>'reason', ''), 'BROWSER_UNAVAILABLE'),
      started_at = LEAST(started_at, NEW.event_timestamp)
      WHERE verification_session_id = NEW.verification_session_id AND ended_at IS NULL;
    INSERT INTO monitoring_interruptions(verification_session_id, started_at, reason)
    VALUES (NEW.verification_session_id, NEW.event_timestamp,
      COALESCE(NULLIF(NEW.payload->>'reason', ''), 'BROWSER_UNAVAILABLE')) ON CONFLICT DO NOTHING;
    UPDATE verification_sessions SET monitoring_health = 'INTERRUPTED'
      WHERE id = NEW.verification_session_id AND status = 'MONITORING_ACTIVE';
  ELSIF NEW.event_type = 'BROWSER_PROFILE_HEALTH'
      AND NEW.payload->>'activeProfileVerified' = 'true' THEN
    SELECT max(received_at) INTO last_seen FROM agent_heartbeats
      WHERE verification_session_id = NEW.verification_session_id
        AND received_at <= NEW.event_timestamp;
    IF last_seen IS NULL OR NEW.event_timestamp >= last_seen + interval '10 seconds' THEN
      UPDATE monitoring_interruptions SET reason = 'HEARTBEAT_MISSED'
        WHERE verification_session_id = NEW.verification_session_id AND ended_at IS NULL;
    ELSE
      UPDATE monitoring_interruptions SET ended_at = NEW.event_timestamp
        WHERE verification_session_id = NEW.verification_session_id AND ended_at IS NULL
          AND reason IN ('RULE_PACK_UNAVAILABLE', 'PROFILE_MISMATCH', 'BROWSER_UNAVAILABLE',
            'EXTENSION_DISABLED');
      UPDATE verification_sessions SET monitoring_health = 'ACTIVE'
        WHERE id = NEW.verification_session_id AND status = 'MONITORING_ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM monitoring_interruptions item
            WHERE item.verification_session_id = NEW.verification_session_id
              AND item.ended_at IS NULL);
    END IF;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION authenti8_publish_rule_pack(JSONB),
  authenti8_approve_detection_rule(JSONB), authenti8_disable_detection_rule(JSONB),
  authenti8_active_rule_pack(JSONB), authenti8_recruiter_meeting(JSONB),
  authenti8_recruiter_logs(JSONB), authenti8_issue_recruiter_token(JSONB),
  authenti8_rotate_recruiter_token(JSONB), authenti8_resolve_recruiter_token(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_publish_rule_pack(JSONB),
  authenti8_approve_detection_rule(JSONB), authenti8_disable_detection_rule(JSONB),
  authenti8_active_rule_pack(JSONB), authenti8_recruiter_meeting(JSONB),
  authenti8_recruiter_logs(JSONB), authenti8_issue_recruiter_token(JSONB),
  authenti8_rotate_recruiter_token(JSONB), authenti8_resolve_recruiter_token(JSONB)
  TO service_role;

INSERT INTO schema_migrations(version) VALUES ('036_detection_and_live_logs')
  ON CONFLICT DO NOTHING;
COMMIT;
