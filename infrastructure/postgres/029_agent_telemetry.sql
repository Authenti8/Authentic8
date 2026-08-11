BEGIN;

ALTER TABLE telemetry_events ADD COLUMN event_chain_hash TEXT;
ALTER TABLE telemetry_events ADD CONSTRAINT telemetry_event_chain_hash_format
  CHECK (event_chain_hash ~ '^[a-f0-9]{64}$');
CREATE UNIQUE INDEX telemetry_events_event_id_idx ON telemetry_events(id);

CREATE OR REPLACE FUNCTION authenti8_agent_context(input JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE session_row verification_sessions; device candidate_devices; interview_row interviews;
BEGIN
  SELECT * INTO session_row FROM verification_sessions
    WHERE id = (input->>'verificationSessionId')::UUID;
  IF session_row.id IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'SESSION_UNAVAILABLE');
  END IF;
  SELECT * INTO device FROM candidate_devices WHERE verification_session_id = session_row.id
    AND revoked_at IS NULL;
  IF device.id IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'DEVICE_NOT_ENROLLED');
  END IF;
  SELECT * INTO interview_row FROM interviews WHERE id = session_row.interview_id;
  RETURN jsonb_build_object('authorized', true, 'deviceId', device.id,
    'publicKey', device.public_key, 'platform', device.platform,
    'agentVersion', device.agent_version, 'interviewId', interview_row.id,
    'sessionStatus', session_row.status, 'eligibleStart', session_row.eligible_start,
    'eligibleEnd', session_row.eligible_end,
    'replayOnly', session_row.status NOT IN ('CONSENTED', 'MONITORING_ACTIVE')
      OR session_row.eligible_end <= now());
END $$;

CREATE OR REPLACE FUNCTION authenti8_ingest_agent_event(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE session_row verification_sessions; device candidate_devices; prior telemetry_events;
  existing telemetry_events;
  supplied_sequence BIGINT := (input->>'sequenceNumber')::BIGINT; consumption JSONB;
BEGIN
  SELECT * INTO existing FROM telemetry_events WHERE id = (input->>'eventId')::UUID;
  IF existing.id IS NOT NULL THEN
    IF existing.verification_session_id = (input->>'verificationSessionId')::UUID
      AND existing.sequence_number = supplied_sequence
      AND existing.signature = input->>'signature'
      AND existing.event_chain_hash = input->>'eventChainHash' THEN
      RETURN jsonb_build_object('accepted', true, 'sequenceNumber', supplied_sequence,
        'replayed', true);
    END IF;
    RETURN jsonb_build_object('accepted', false, 'reason', 'DUPLICATE_EVENT');
  END IF;
  SELECT * INTO session_row FROM verification_sessions
    WHERE id = (input->>'verificationSessionId')::UUID FOR UPDATE;
  SELECT * INTO device FROM candidate_devices WHERE verification_session_id = session_row.id
    AND revoked_at IS NULL;
  IF session_row.id IS NULL OR device.id IS NULL
    OR session_row.status NOT IN ('CONSENTED', 'MONITORING_ACTIVE')
    OR session_row.eligible_end <= now() THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'NOT_AUTHORIZED');
  END IF;
  IF device.platform <> input->>'platform' OR device.agent_version <> input->>'agentVersion' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'DEVICE_MISMATCH');
  END IF;
  IF (input->>'eventTimestamp')::TIMESTAMPTZ < session_row.eligible_start
    OR (input->>'eventTimestamp')::TIMESTAMPTZ > session_row.eligible_end
    OR (input->>'eventTimestamp')::TIMESTAMPTZ > now() + interval '5 minutes' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'EVENT_OUTSIDE_WINDOW');
  END IF;
  SELECT * INTO prior FROM telemetry_events WHERE verification_session_id = session_row.id
    ORDER BY sequence_number DESC LIMIT 1 FOR UPDATE;
  IF prior.id IS NULL AND (supplied_sequence <> 0 OR NULLIF(input->>'previousEventHash', '') IS NOT NULL) THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'INVALID_SEQUENCE');
  END IF;
  IF prior.id IS NOT NULL AND (supplied_sequence <> prior.sequence_number + 1
    OR input->>'previousEventHash' IS DISTINCT FROM prior.event_chain_hash) THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'INVALID_SEQUENCE');
  END IF;
  IF prior.id IS NULL AND (input->>'eventType' <> 'MONITORING_STARTED'
    OR session_row.status <> 'CONSENTED') THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'MONITORING_NOT_STARTED');
  END IF;
  IF prior.id IS NOT NULL AND (session_row.status <> 'MONITORING_ACTIVE'
    OR input->>'eventType' = 'MONITORING_STARTED') THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'MONITORING_NOT_ACTIVE');
  END IF;
  IF input->>'eventType' = 'MONITORING_STARTED' THEN
    consumption := authenti8_consume_credit(
      jsonb_build_object('interviewId', session_row.interview_id));
    IF COALESCE((consumption->>'consumed')::BOOLEAN, false) IS NOT TRUE THEN
      RETURN jsonb_build_object('accepted', false, 'reason',
        COALESCE(consumption->>'reason', 'MONITORING_START_REJECTED'));
    END IF;
  END IF;
  INSERT INTO telemetry_events(id, verification_session_id, sequence_number, event_type,
    event_timestamp, monotonic_timestamp, platform, payload, payload_hash,
    previous_event_hash, agent_version, rule_pack_version, signature, event_chain_hash)
  VALUES ((input->>'eventId')::UUID, session_row.id, supplied_sequence, input->>'eventType',
    (input->>'eventTimestamp')::TIMESTAMPTZ, (input->>'monotonicTimestamp')::BIGINT,
    input->>'platform', input->'payload', input->>'payloadHash',
    NULLIF(input->>'previousEventHash', ''), input->>'agentVersion',
    input->>'rulePackVersion', input->>'signature', input->>'eventChainHash');
  IF input->>'eventType' = 'HEARTBEAT' THEN
    INSERT INTO agent_heartbeats(verification_session_id, sequence_number)
      VALUES (session_row.id, supplied_sequence) ON CONFLICT DO NOTHING;
  END IF;
  IF input->>'eventType' = 'MONITORING_STOPPED' THEN
    UPDATE verification_sessions SET status = 'COMPLETED', monitoring_ended_at = now()
      WHERE id = session_row.id AND status = 'MONITORING_ACTIVE';
    PERFORM authenti8_transition_interview(session_row.interview_id,
      ARRAY['MONITORING_ACTIVE'], 'MEETING_COMPLETED', 'AGENT_MONITORING_STOPPED');
  END IF;
  RETURN jsonb_build_object('accepted', true, 'sequenceNumber', supplied_sequence);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('accepted', false, 'reason', 'DUPLICATE_EVENT');
END $$;

REVOKE ALL ON FUNCTION authenti8_agent_context(JSONB), authenti8_ingest_agent_event(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_agent_context(JSONB), authenti8_ingest_agent_event(JSONB)
  TO service_role;

INSERT INTO schema_migrations(version) VALUES ('029_agent_telemetry') ON CONFLICT DO NOTHING;
COMMIT;
