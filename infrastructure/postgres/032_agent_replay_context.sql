BEGIN;

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

INSERT INTO schema_migrations(version) VALUES ('032_agent_replay_context')
  ON CONFLICT DO NOTHING;
COMMIT;
