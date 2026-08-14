BEGIN;

ALTER TABLE verification_sessions
  ADD COLUMN monitoring_health TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (monitoring_health IN ('PENDING', 'ACTIVE', 'INTERRUPTED', 'COMPLETED')),
  ADD COLUMN stop_reason TEXT;

CREATE TABLE monitoring_interruptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_session_id UUID NOT NULL
    REFERENCES verification_sessions(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX monitoring_interruptions_open_idx
  ON monitoring_interruptions(verification_session_id) WHERE ended_at IS NULL;
CREATE INDEX monitoring_interruptions_session_idx
  ON monitoring_interruptions(verification_session_id, started_at);
ALTER TABLE monitoring_interruptions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION authenti8_calculate_monitoring_coverage(
  session_id UUID, ending TIMESTAMPTZ
) RETURNS NUMERIC LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE session_row verification_sessions; eligible_seconds NUMERIC; interrupted_seconds NUMERIC;
BEGIN
  SELECT * INTO session_row FROM verification_sessions WHERE id = session_id;
  IF session_row.monitoring_started_at IS NULL OR ending <= session_row.monitoring_started_at THEN
    RETURN 0;
  END IF;
  eligible_seconds := EXTRACT(EPOCH FROM ending - session_row.monitoring_started_at);
  SELECT COALESCE(sum(EXTRACT(EPOCH FROM
    LEAST(COALESCE(item.ended_at, ending), ending) -
    GREATEST(item.started_at, session_row.monitoring_started_at))), 0)
  INTO interrupted_seconds FROM monitoring_interruptions item
  WHERE item.verification_session_id = session_id
    AND item.started_at < ending
    AND COALESCE(item.ended_at, ending) > session_row.monitoring_started_at;
  RETURN round(GREATEST(0, LEAST(100,
    ((eligible_seconds - interrupted_seconds) / eligible_seconds) * 100)), 2);
END $$;

CREATE OR REPLACE FUNCTION authenti8_finish_monitoring(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE session_row verification_sessions; ending TIMESTAMPTZ;
  final_coverage NUMERIC; reason TEXT := COALESCE(NULLIF(input->>'reason', ''), 'AUTHORIZED_STOP');
BEGIN
  SELECT * INTO session_row FROM verification_sessions
    WHERE id = (input->>'verificationSessionId')::UUID FOR UPDATE;
  IF session_row.id IS NULL THEN
    RETURN jsonb_build_object('stopped', false, 'reason', 'SESSION_UNAVAILABLE');
  END IF;
  IF session_row.status = 'COMPLETED' AND session_row.monitoring_health = 'COMPLETED'
    AND session_row.coverage_percentage IS NOT NULL THEN
    RETURN jsonb_build_object('stopped', true, 'replayed', true,
      'coveragePercentage', session_row.coverage_percentage);
  END IF;
  IF session_row.status NOT IN ('MONITORING_ACTIVE', 'COMPLETED')
    OR session_row.monitoring_started_at IS NULL THEN
    RETURN jsonb_build_object('stopped', false, 'reason', 'MONITORING_NOT_ACTIVE');
  END IF;
  ending := LEAST(COALESCE((input->>'endedAt')::TIMESTAMPTZ, now()),
    session_row.eligible_end);
  ending := GREATEST(ending, session_row.monitoring_started_at);
  UPDATE monitoring_interruptions SET ended_at = ending
    WHERE verification_session_id = session_row.id AND ended_at IS NULL;
  final_coverage := authenti8_calculate_monitoring_coverage(session_row.id, ending);
  UPDATE verification_sessions SET status = 'COMPLETED', monitoring_health = 'COMPLETED',
    monitoring_ended_at = ending, coverage_percentage = final_coverage, stop_reason = reason
    WHERE id = session_row.id;
  UPDATE interviews SET monitoring_ended_at = ending, coverage_percentage = final_coverage,
    updated_at = now() WHERE id = session_row.interview_id;
  PERFORM authenti8_transition_interview(session_row.interview_id,
    ARRAY['MONITORING_ACTIVE'], 'MEETING_COMPLETED', reason);
  RETURN jsonb_build_object('stopped', true, 'coveragePercentage', final_coverage);
END $$;

CREATE OR REPLACE FUNCTION authenti8_close_interruption_on_heartbeat() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE interruption monitoring_interruptions; org UUID; interview UUID;
BEGIN
  UPDATE monitoring_interruptions SET ended_at = NEW.received_at
    WHERE verification_session_id = NEW.verification_session_id AND ended_at IS NULL
    RETURNING * INTO interruption;
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

CREATE TRIGGER authenti8_heartbeat_closes_interruption
AFTER INSERT ON agent_heartbeats FOR EACH ROW
EXECUTE FUNCTION authenti8_close_interruption_on_heartbeat();

CREATE OR REPLACE FUNCTION authenti8_finish_on_stop_event() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.event_type = 'MONITORING_STOPPED' THEN
    PERFORM authenti8_finish_monitoring(jsonb_build_object(
      'verificationSessionId', NEW.verification_session_id,
      'endedAt', NEW.event_timestamp,
      'reason', COALESCE(NEW.payload->>'reason', 'AGENT_MONITORING_STOPPED')));
  ELSIF NEW.event_type = 'MONITORING_STARTED' THEN
    UPDATE verification_sessions SET monitoring_health = 'ACTIVE'
      WHERE id = NEW.verification_session_id AND status = 'MONITORING_ACTIVE';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER authenti8_telemetry_monitoring_state
AFTER INSERT ON telemetry_events FOR EACH ROW
EXECUTE FUNCTION authenti8_finish_on_stop_event();

CREATE OR REPLACE FUNCTION authenti8_orchestrate_monitoring(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE item RECORD; clock TIMESTAMPTZ := COALESCE((input->>'at')::TIMESTAMPTZ, now());
  opened INTEGER := 0; stopped INTEGER := 0; last_seen TIMESTAMPTZ; interruption_start TIMESTAMPTZ;
BEGIN
  FOR item IN SELECT session.id, session.interview_id, session.monitoring_started_at,
      session.eligible_end, interview.organization_id
    FROM verification_sessions session JOIN interviews interview ON interview.id = session.interview_id
    WHERE session.status = 'MONITORING_ACTIVE' ORDER BY session.monitoring_started_at
    FOR UPDATE OF session SKIP LOCKED LOOP
    SELECT max(received_at) INTO last_seen FROM agent_heartbeats
      WHERE verification_session_id = item.id AND received_at <= clock;
    last_seen := COALESCE(last_seen, item.monitoring_started_at);
    interruption_start := last_seen + interval '5 seconds';
    IF clock >= last_seen + interval '10 seconds' AND NOT EXISTS (
      SELECT 1 FROM monitoring_interruptions WHERE verification_session_id = item.id
        AND ended_at IS NULL) AND interruption_start < item.eligible_end THEN
      INSERT INTO monitoring_interruptions(verification_session_id, started_at, reason)
      VALUES (item.id, interruption_start, 'HEARTBEAT_MISSED');
      UPDATE verification_sessions SET monitoring_health = 'INTERRUPTED' WHERE id = item.id;
      INSERT INTO workspace_notifications(organization_id, interview_id, kind, message, idempotency_key)
      VALUES (item.organization_id, item.interview_id, 'MONITORING_INTERRUPTED',
        'Candidate device monitoring was interrupted.', 'monitoring-interrupted:' || item.id ||
        ':' || interruption_start::TEXT) ON CONFLICT DO NOTHING;
      opened := opened + 1;
    END IF;
    IF clock >= item.eligible_end THEN
      PERFORM authenti8_finish_monitoring(jsonb_build_object('verificationSessionId', item.id,
        'endedAt', item.eligible_end, 'reason', 'AUTHORIZED_WINDOW_ENDED'));
      stopped := stopped + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('interruptionsOpened', opened, 'sessionsStopped', stopped);
END $$;

CREATE OR REPLACE FUNCTION authenti8_candidate_end_monitoring(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE session_id UUID;
BEGIN
  SELECT consent.verification_session_id INTO session_id
  FROM candidate_verification_tokens token JOIN candidate_consents consent
    ON consent.verification_token_id = token.id
  WHERE token.token_hash = input->>'tokenHash' AND token.decision = 'ACCEPTED';
  IF session_id IS NULL THEN
    RETURN jsonb_build_object('stopped', false, 'reason', 'SESSION_UNAVAILABLE');
  END IF;
  RETURN authenti8_finish_monitoring(jsonb_build_object('verificationSessionId', session_id,
    'reason', 'CANDIDATE_ENDED'));
END $$;

CREATE OR REPLACE FUNCTION authenti8_recruiter_end_monitoring(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE session_id UUID;
BEGIN
  SELECT session.id INTO session_id FROM verification_sessions session
  JOIN interviews interview ON interview.id = session.interview_id
  JOIN organization_members member ON member.organization_id = interview.organization_id
  WHERE interview.id = (input->>'interviewId')::UUID
    AND member.user_id = (input->>'userId')::UUID
    AND member.role IN ('OWNER', 'ADMIN', 'MEMBER')
    AND session.status = 'MONITORING_ACTIVE';
  IF session_id IS NULL THEN
    RETURN jsonb_build_object('stopped', false, 'reason', 'SESSION_UNAVAILABLE');
  END IF;
  RETURN authenti8_finish_monitoring(jsonb_build_object('verificationSessionId', session_id,
    'reason', 'RECRUITER_ENDED'));
END $$;

REVOKE ALL ON FUNCTION authenti8_calculate_monitoring_coverage(UUID, TIMESTAMPTZ),
  authenti8_finish_monitoring(JSONB), authenti8_orchestrate_monitoring(JSONB),
  authenti8_candidate_end_monitoring(JSONB), authenti8_recruiter_end_monitoring(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_calculate_monitoring_coverage(UUID, TIMESTAMPTZ),
  authenti8_finish_monitoring(JSONB), authenti8_orchestrate_monitoring(JSONB),
  authenti8_candidate_end_monitoring(JSONB), authenti8_recruiter_end_monitoring(JSONB)
  TO service_role;

INSERT INTO schema_migrations(version) VALUES ('035_monitoring_orchestrator')
  ON CONFLICT DO NOTHING;
COMMIT;
