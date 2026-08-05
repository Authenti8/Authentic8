BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenti8_backend') THEN
    EXECUTE 'ALTER ROLE authenti8_backend NOLOGIN PASSWORD NULL';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM authenti8_backend';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM authenti8_backend';
    EXECUTE 'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM authenti8_backend';
    EXECUTE 'REVOKE USAGE ON SCHEMA public FROM authenti8_backend';
  END IF;
END $$;

REVOKE ALL ON FUNCTION authenti8_has_organization_access(UUID)
  FROM PUBLIC, anon, authenticated, authenti8_backend;

CREATE OR REPLACE FUNCTION authenti8_health(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('ok', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_find_user(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(found) FROM (
    SELECT * FROM users WHERE normalized_email = input->>'normalizedEmail' LIMIT 1
  ) found
$$;

CREATE OR REPLACE FUNCTION authenti8_create_user(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE created users;
BEGIN
  INSERT INTO users(email, normalized_email, full_name)
  VALUES (input->>'email', input->>'email', input->>'fullName')
  ON CONFLICT (normalized_email) DO NOTHING RETURNING * INTO created;
  IF created.id IS NULL THEN RETURN NULL; END IF;
  RETURN to_jsonb(created);
END $$;

CREATE OR REPLACE FUNCTION authenti8_create_signup_token(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO email_verification_tokens(
    user_id, token_hash, pending_password_hash, pending_full_name, expires_at
  ) VALUES (
    (input->>'userId')::UUID, input->>'tokenHash', input->>'passwordHash',
    input->>'fullName', (input->>'expiresAt')::TIMESTAMPTZ
  ) RETURNING jsonb_build_object('created', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_get_signup_token(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'pending_password_hash', pending_password_hash,
    'pending_full_name', pending_full_name, 'user_id', user_id
  ) FROM email_verification_tokens
  WHERE token_hash = input->>'tokenHash' AND consumed_at IS NULL AND expires_at > now()
$$;

CREATE OR REPLACE FUNCTION authenti8_complete_signup(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE pending email_verification_tokens; activated UUID;
BEGIN
  UPDATE email_verification_tokens SET consumed_at = now()
  WHERE token_hash = input->>'tokenHash' AND consumed_at IS NULL AND expires_at > now()
  RETURNING * INTO pending;
  IF pending.id IS NULL THEN RETURN NULL; END IF;
  UPDATE users SET password_hash = pending.pending_password_hash,
    full_name = pending.pending_full_name, email_verified_at = now(), updated_at = now()
  WHERE id = pending.user_id AND email_verified_at IS NULL AND status = 'ACTIVE'
  RETURNING id INTO activated;
  IF activated IS NULL THEN RETURN NULL; END IF;
  UPDATE email_verification_tokens SET consumed_at = now()
  WHERE user_id = activated AND consumed_at IS NULL;
  RETURN to_jsonb(activated);
END $$;

CREATE OR REPLACE FUNCTION authenti8_create_reset_token(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE recent BOOLEAN; outbox JSONB := input->'outbox';
BEGIN
  PERFORM id FROM users WHERE id = (input->>'userId')::UUID FOR UPDATE;
  SELECT EXISTS(SELECT 1 FROM password_reset_tokens
    WHERE user_id = (input->>'userId')::UUID AND consumed_at IS NULL
      AND created_at > now() - interval '2 minutes') INTO recent;
  IF recent THEN RETURN 'false'::JSONB; END IF;
  INSERT INTO password_reset_tokens(user_id, token_hash, expires_at)
  VALUES ((input->>'userId')::UUID, input->>'tokenHash',
    (input->>'expiresAt')::TIMESTAMPTZ);
  IF outbox IS NOT NULL AND outbox <> 'null'::JSONB THEN
    INSERT INTO auth_email_outbox(
      recipient, kind, encrypted_token, initialization_vector, authentication_tag
    ) VALUES (outbox->>'recipient', outbox->>'kind', outbox->>'encryptedToken',
      outbox->>'initializationVector', outbox->>'authenticationTag');
  END IF;
  RETURN 'true'::JSONB;
END $$;

CREATE OR REPLACE FUNCTION authenti8_reset_password(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE reset_row password_reset_tokens; eligible UUID;
BEGIN
  UPDATE password_reset_tokens SET consumed_at = now()
  WHERE token_hash = input->>'tokenHash' AND consumed_at IS NULL AND expires_at > now()
  RETURNING * INTO reset_row;
  IF reset_row.id IS NULL THEN RETURN 'false'::JSONB; END IF;
  SELECT id INTO eligible FROM users
  WHERE id = reset_row.user_id AND status = 'ACTIVE' FOR UPDATE;
  IF eligible IS NULL THEN RETURN 'false'::JSONB; END IF;
  UPDATE password_reset_tokens SET consumed_at = now()
  WHERE user_id = eligible AND consumed_at IS NULL;
  UPDATE users SET password_hash = input->>'passwordHash', updated_at = now()
  WHERE id = eligible;
  UPDATE sessions SET revoked_at = now() WHERE user_id = eligible;
  RETURN 'true'::JSONB;
END $$;

CREATE OR REPLACE FUNCTION authenti8_create_session(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO sessions(user_id, token_hash, expires_at, user_agent_hash, ip_hash)
  SELECT (input->>'userId')::UUID, input->>'tokenHash',
    (input->>'expiresAt')::TIMESTAMPTZ, input->>'userAgentHash', input->>'ipHash'
  FROM users WHERE id = (input->>'userId')::UUID AND status = 'ACTIVE'
  RETURNING jsonb_build_object('created', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_resolve_session(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH resolved AS (
    UPDATE sessions SET last_seen_at = now()
    WHERE token_hash = input->>'tokenHash' AND revoked_at IS NULL AND expires_at > now()
      AND user_id IN (SELECT id FROM users WHERE status = 'ACTIVE')
    RETURNING id, user_id
  ) SELECT jsonb_build_object('id', id, 'userId', user_id) FROM resolved
$$;

CREATE OR REPLACE FUNCTION authenti8_current_session(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'user', jsonb_build_object('id', u.id, 'email', u.email, 'fullName', u.full_name,
      'emailVerified', u.email_verified_at IS NOT NULL),
    'organization', CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', o.id, 'name', o.name, 'domain', o.domain, 'role', membership.role) END
  ) FROM users u
  LEFT JOIN LATERAL (SELECT * FROM organization_members
    WHERE user_id = u.id ORDER BY created_at LIMIT 1) membership ON true
  LEFT JOIN organizations o ON o.id = membership.organization_id
  WHERE u.id = (input->>'userId')::UUID AND u.status = 'ACTIVE'
$$;

CREATE OR REPLACE FUNCTION authenti8_revoke_session(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE sessions SET revoked_at = now() WHERE token_hash = input->>'tokenHash'
  RETURNING jsonb_build_object('revoked', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_create_oauth_state(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO oauth_states(state_hash, verifier, return_path, expires_at)
  VALUES (input->>'stateHash', input->>'verifier', input->>'returnPath',
    (input->>'expiresAt')::TIMESTAMPTZ)
  RETURNING jsonb_build_object('created', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_consume_oauth_state(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH consumed AS (
    UPDATE oauth_states SET consumed_at = now()
    WHERE state_hash = input->>'stateHash' AND consumed_at IS NULL AND expires_at > now()
    RETURNING verifier, return_path
  ) SELECT jsonb_build_object('verifier', verifier, 'returnPath', return_path) FROM consumed
$$;

CREATE OR REPLACE FUNCTION authenti8_upsert_google_user(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE target UUID; account_status TEXT;
BEGIN
  SELECT identity_row.user_id, account.status INTO target, account_status
  FROM auth_identities identity_row JOIN users account ON account.id = identity_row.user_id
  WHERE identity_row.provider = 'GOOGLE' AND identity_row.provider_subject = input->>'subject';
  IF target IS NOT NULL THEN
    IF account_status <> 'ACTIVE' THEN RETURN NULL; END IF;
    RETURN to_jsonb(target);
  END IF;
  SELECT id, status INTO target, account_status FROM users
  WHERE normalized_email = lower(input->>'email') FOR UPDATE;
  IF target IS NOT NULL AND account_status <> 'ACTIVE' THEN RETURN NULL; END IF;
  IF target IS NULL THEN
    INSERT INTO users(email, normalized_email, full_name, email_verified_at)
    VALUES (lower(input->>'email'), lower(input->>'email'), input->>'fullName', now())
    ON CONFLICT (normalized_email) DO NOTHING RETURNING id INTO target;
    IF target IS NULL THEN
      SELECT id, status INTO target, account_status FROM users
      WHERE normalized_email = lower(input->>'email') FOR UPDATE;
      IF account_status <> 'ACTIVE' THEN RETURN NULL; END IF;
    END IF;
  ELSE
    UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = target;
  END IF;
  INSERT INTO auth_identities(user_id, provider, provider_subject, provider_email)
  VALUES (target, 'GOOGLE', input->>'subject', lower(input->>'email'))
  ON CONFLICT DO NOTHING;
  SELECT user_id INTO target FROM auth_identities
  WHERE provider = 'GOOGLE' AND provider_subject = input->>'subject';
  RETURN to_jsonb(target);
END $$;

CREATE OR REPLACE FUNCTION authenti8_consume_rate_limit(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE count_value INTEGER; request_time TIMESTAMPTZ := now();
BEGIN
  INSERT INTO auth_rate_limits(key_hash, request_count, window_started_at, expires_at)
  VALUES (input->>'keyHash', 1, request_time,
    request_time + (input->>'windowMs')::BIGINT * interval '1 millisecond')
  ON CONFLICT (key_hash) DO UPDATE SET
    request_count = CASE WHEN auth_rate_limits.expires_at <= request_time
      THEN 1 ELSE auth_rate_limits.request_count + 1 END,
    window_started_at = CASE WHEN auth_rate_limits.expires_at <= request_time
      THEN request_time ELSE auth_rate_limits.window_started_at END,
    expires_at = CASE WHEN auth_rate_limits.expires_at <= request_time
      THEN request_time + (input->>'windowMs')::BIGINT * interval '1 millisecond'
      ELSE auth_rate_limits.expires_at END
  RETURNING request_count INTO count_value;
  RETURN to_jsonb(count_value);
END $$;

CREATE OR REPLACE FUNCTION authenti8_cleanup_rate_limits(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH candidates AS (
    SELECT key_hash FROM auth_rate_limits
    WHERE expires_at <= now() ORDER BY expires_at
    FOR UPDATE SKIP LOCKED LIMIT 100
  ), removed AS (
    DELETE FROM auth_rate_limits limits USING candidates
    WHERE limits.key_hash = candidates.key_hash RETURNING 1
  ) SELECT to_jsonb(count(*)) FROM removed
$$;

CREATE OR REPLACE FUNCTION authenti8_enqueue_email(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO auth_email_outbox(
    recipient, kind, encrypted_token, initialization_vector, authentication_tag
  ) VALUES (input->>'recipient', input->>'kind', input->>'encryptedToken',
    input->>'initializationVector', input->>'authenticationTag')
  RETURNING jsonb_build_object('created', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_claim_email(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH candidate AS (
    SELECT id FROM auth_email_outbox
    WHERE (status = 'PENDING' AND available_at <= now())
       OR (status = 'PROCESSING' AND lease_until <= now())
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
  ), claimed AS (
    UPDATE auth_email_outbox outbox SET status = 'PROCESSING',
      attempts = attempts + 1, lease_until = now() + interval '5 minutes'
    FROM candidate WHERE outbox.id = candidate.id RETURNING outbox.*
  ) SELECT jsonb_build_object(
    'id', id, 'recipient', recipient, 'kind', kind, 'encryptedToken', encrypted_token,
    'initializationVector', initialization_vector, 'authenticationTag', authentication_tag,
    'attempts', attempts) FROM claimed
$$;

CREATE OR REPLACE FUNCTION authenti8_complete_email(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE auth_email_outbox SET status = 'SENT', sent_at = now(), lease_until = NULL,
    encrypted_token = NULL, initialization_vector = NULL, authentication_tag = NULL
  WHERE id = (input->>'id')::UUID AND status = 'PROCESSING'
    AND attempts = (input->>'attempts')::INTEGER
  RETURNING jsonb_build_object('completed', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_renew_email(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE auth_email_outbox SET lease_until = now() + interval '5 minutes'
  WHERE id = (input->>'id')::UUID AND status = 'PROCESSING'
    AND attempts = (input->>'attempts')::INTEGER
  RETURNING jsonb_build_object('renewed', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_fail_email(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE auth_email_outbox SET
    status = CASE WHEN attempts >= 5 THEN 'FAILED' ELSE 'PENDING' END,
    available_at = now() + LEAST(300, 5 * power(2, attempts)) * interval '1 second',
    lease_until = NULL,
    encrypted_token = CASE WHEN attempts >= 5 THEN NULL ELSE encrypted_token END,
    initialization_vector = CASE WHEN attempts >= 5 THEN NULL ELSE initialization_vector END,
    authentication_tag = CASE WHEN attempts >= 5 THEN NULL ELSE authentication_tag END,
    last_error = left(input->>'error', 500)
  WHERE id = (input->>'id')::UUID AND status = 'PROCESSING'
    AND attempts = (input->>'attempts')::INTEGER
  RETURNING jsonb_build_object('failed', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_cleanup_email(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH removed AS (
    DELETE FROM auth_email_outbox WHERE status IN ('SENT', 'FAILED')
      AND created_at < now() - interval '7 days' RETURNING 1
  ) SELECT to_jsonb(count(*)) FROM removed
$$;

DO $$
DECLARE function_name TEXT;
BEGIN
  FOREACH function_name IN ARRAY ARRAY[
    'authenti8_health', 'authenti8_find_user', 'authenti8_create_user',
    'authenti8_create_signup_token', 'authenti8_get_signup_token',
    'authenti8_complete_signup', 'authenti8_create_reset_token',
    'authenti8_reset_password', 'authenti8_create_session',
    'authenti8_resolve_session', 'authenti8_current_session',
    'authenti8_revoke_session', 'authenti8_create_oauth_state',
    'authenti8_consume_oauth_state', 'authenti8_upsert_google_user',
    'authenti8_consume_rate_limit', 'authenti8_cleanup_rate_limits',
    'authenti8_enqueue_email',
    'authenti8_claim_email', 'authenti8_complete_email', 'authenti8_renew_email',
    'authenti8_fail_email', 'authenti8_cleanup_email'
  ] LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %I(JSONB) FROM PUBLIC, anon, authenticated',
      function_name
    );
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I(JSONB) TO service_role', function_name);
  END LOOP;
END $$;

INSERT INTO schema_migrations(version) VALUES ('007_supabase_data_api');
COMMIT;
