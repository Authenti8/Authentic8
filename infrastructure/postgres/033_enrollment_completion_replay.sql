BEGIN;

CREATE OR REPLACE FUNCTION authenti8_replay_device_enrollment(input JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE enrollment device_enrollment_secrets; device candidate_devices;
  session_row verification_sessions;
BEGIN
  SELECT * INTO enrollment FROM device_enrollment_secrets
    WHERE secret_hash = input->>'tokenHash';
  IF enrollment.id IS NULL OR enrollment.consumed_at IS NULL THEN
    RETURN jsonb_build_object('enrolled', false, 'reason', 'TOKEN_UNAVAILABLE');
  END IF;
  SELECT * INTO device FROM candidate_devices
    WHERE verification_session_id = enrollment.verification_session_id
      AND public_key_fingerprint = input->>'publicKeyFingerprint' AND revoked_at IS NULL;
  IF device.id IS NULL THEN
    RETURN jsonb_build_object('enrolled', false, 'reason', 'TOKEN_UNAVAILABLE');
  END IF;
  SELECT * INTO session_row FROM verification_sessions WHERE id = enrollment.verification_session_id;
  RETURN jsonb_build_object('enrolled', true, 'replayed', true, 'deviceId', device.id,
    'verificationSessionId', session_row.id, 'eligibleStart', session_row.eligible_start,
    'eligibleEnd', session_row.eligible_end);
END $$;

REVOKE ALL ON FUNCTION authenti8_replay_device_enrollment(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_replay_device_enrollment(JSONB) TO service_role;

INSERT INTO schema_migrations(version) VALUES ('033_enrollment_completion_replay')
  ON CONFLICT DO NOTHING;
COMMIT;
