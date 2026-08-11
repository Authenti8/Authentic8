BEGIN;

CREATE TABLE device_enrollment_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_session_id UUID NOT NULL REFERENCES verification_sessions(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL UNIQUE,
  server_challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX device_enrollment_active_session_idx
  ON device_enrollment_secrets(verification_session_id)
  WHERE consumed_at IS NULL;

ALTER TABLE candidate_devices ADD COLUMN device_name TEXT;
ALTER TABLE candidate_devices ADD COLUMN key_algorithm TEXT NOT NULL DEFAULT 'Ed25519'
  CHECK (key_algorithm = 'Ed25519');
ALTER TABLE candidate_devices ADD COLUMN public_key_fingerprint TEXT;
CREATE UNIQUE INDEX candidate_devices_key_fingerprint_idx
  ON candidate_devices(public_key_fingerprint) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION authenti8_prepare_device_enrollment(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE session_row verification_sessions; active_secret device_enrollment_secrets;
  raw_challenge TEXT; expiration TIMESTAMPTZ;
BEGIN
  SELECT * INTO session_row FROM verification_sessions
    WHERE id = (input->>'verificationSessionId')::UUID FOR UPDATE;
  IF session_row.id IS NULL OR session_row.status <> 'CONSENTED'
    OR session_row.eligible_end <= now() THEN
    RETURN jsonb_build_object('prepared', false, 'reason', 'SESSION_UNAVAILABLE');
  END IF;
  IF EXISTS (SELECT 1 FROM candidate_devices WHERE verification_session_id = session_row.id
    AND revoked_at IS NULL) THEN
    RETURN jsonb_build_object('prepared', false, 'reason', 'DEVICE_ALREADY_ENROLLED');
  END IF;
  IF input->>'secretHash' !~ '^[a-f0-9]{64}$' THEN
    RETURN jsonb_build_object('prepared', false, 'reason', 'INVALID_SECRET');
  END IF;
  SELECT * INTO active_secret FROM device_enrollment_secrets
    WHERE verification_session_id = session_row.id AND consumed_at IS NULL FOR UPDATE;
  IF active_secret.id IS NOT NULL AND active_secret.expires_at > now() THEN
    IF active_secret.secret_hash IS DISTINCT FROM input->>'secretHash' THEN
      RETURN jsonb_build_object('prepared', false, 'reason', 'ENROLLMENT_ALREADY_PREPARED');
    END IF;
    RETURN jsonb_build_object('prepared', true, 'expiresAt', active_secret.expires_at);
  END IF;
  UPDATE device_enrollment_secrets SET consumed_at = COALESCE(consumed_at, now())
    WHERE verification_session_id = session_row.id AND consumed_at IS NULL;
  raw_challenge := encode(gen_random_bytes(32), 'hex');
  expiration := LEAST(session_row.eligible_end, now() + interval '15 minutes');
  INSERT INTO device_enrollment_secrets(
    verification_session_id, secret_hash, server_challenge, expires_at
  ) VALUES (
    session_row.id, input->>'secretHash', raw_challenge, expiration
  );
  RETURN jsonb_build_object('prepared', true, 'expiresAt', expiration);
END $$;

CREATE OR REPLACE FUNCTION authenti8_device_enrollment_challenge(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE enrollment device_enrollment_secrets; session_row verification_sessions;
BEGIN
  SELECT * INTO enrollment FROM device_enrollment_secrets
    WHERE secret_hash = input->>'tokenHash' FOR UPDATE;
  IF enrollment.id IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'NOT_FOUND');
  END IF;
  IF enrollment.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'ALREADY_USED');
  END IF;
  IF enrollment.expires_at <= now() OR enrollment.attempts >= 20 THEN
    UPDATE device_enrollment_secrets SET consumed_at = COALESCE(consumed_at, now())
      WHERE id = enrollment.id;
    RETURN jsonb_build_object('valid', false, 'reason', 'EXPIRED');
  END IF;
  SELECT * INTO session_row FROM verification_sessions
    WHERE id = enrollment.verification_session_id;
  IF session_row.status <> 'CONSENTED' OR session_row.eligible_end <= now() THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'SESSION_UNAVAILABLE');
  END IF;
  UPDATE device_enrollment_secrets SET attempts = attempts + 1 WHERE id = enrollment.id;
  RETURN jsonb_build_object('valid', true,
    'verificationSessionId', enrollment.verification_session_id,
    'challenge', enrollment.server_challenge, 'expiresAt', enrollment.expires_at);
END $$;

CREATE OR REPLACE FUNCTION authenti8_complete_device_enrollment(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE enrollment device_enrollment_secrets; session_row verification_sessions; device_id UUID;
BEGIN
  SELECT * INTO enrollment FROM device_enrollment_secrets
    WHERE secret_hash = input->>'tokenHash' FOR UPDATE;
  IF enrollment.id IS NULL OR enrollment.consumed_at IS NOT NULL
    OR enrollment.expires_at <= now() THEN
    RETURN jsonb_build_object('enrolled', false, 'reason', 'TOKEN_UNAVAILABLE');
  END IF;
  SELECT * INTO session_row FROM verification_sessions
    WHERE id = enrollment.verification_session_id FOR UPDATE;
  IF session_row.status <> 'CONSENTED' OR session_row.eligible_end <= now() THEN
    RETURN jsonb_build_object('enrolled', false, 'reason', 'SESSION_UNAVAILABLE');
  END IF;
  IF input->>'signatureVerified' <> 'true' THEN
    RETURN jsonb_build_object('enrolled', false, 'reason', 'INVALID_SIGNATURE');
  END IF;
  IF EXISTS (SELECT 1 FROM candidate_devices WHERE verification_session_id = session_row.id
    AND revoked_at IS NULL) THEN
    RETURN jsonb_build_object('enrolled', false, 'reason', 'DEVICE_ALREADY_ENROLLED');
  END IF;
  INSERT INTO candidate_devices(verification_session_id, public_key, platform,
    platform_version, agent_version, device_name, public_key_fingerprint)
  VALUES (session_row.id, input->>'publicKey', input->>'platform',
    input->>'platformVersion', input->>'agentVersion', NULLIF(input->>'deviceName', ''),
    input->>'publicKeyFingerprint') RETURNING id INTO device_id;
  UPDATE device_enrollment_secrets SET consumed_at = now() WHERE id = enrollment.id;
  RETURN jsonb_build_object('enrolled', true, 'deviceId', device_id,
    'verificationSessionId', session_row.id, 'eligibleStart', session_row.eligible_start,
    'eligibleEnd', session_row.eligible_end);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('enrolled', false, 'reason', 'DEVICE_ALREADY_ENROLLED');
END $$;

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

ALTER TABLE device_enrollment_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON device_enrollment_secrets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_prepare_device_enrollment(JSONB),
  authenti8_device_enrollment_challenge(JSONB), authenti8_complete_device_enrollment(JSONB),
  authenti8_replay_device_enrollment(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_prepare_device_enrollment(JSONB),
  authenti8_device_enrollment_challenge(JSONB), authenti8_complete_device_enrollment(JSONB),
  authenti8_replay_device_enrollment(JSONB)
  TO service_role;

INSERT INTO schema_migrations(version) VALUES ('028_device_enrollment') ON CONFLICT DO NOTHING;
COMMIT;
