BEGIN;

ALTER TABLE users
  ADD COLUMN supabase_auth_user_id UUID
    REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX users_supabase_auth_user_id_key
  ON users(supabase_auth_user_id)
  WHERE supabase_auth_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION authenti8_upsert_google_user(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE target UUID; account_status TEXT; supplied_auth_id UUID; identity_owner UUID;
BEGIN
  supplied_auth_id := (input->>'supabaseAuthUserId')::UUID;
  SELECT identity_row.user_id INTO target FROM auth_identities identity_row
  WHERE identity_row.provider = 'GOOGLE' AND identity_row.provider_subject = input->>'subject';
  IF target IS NULL THEN
    SELECT id INTO target FROM users
    WHERE normalized_email = lower(input->>'email') FOR UPDATE;
  END IF;
  IF target IS NULL THEN
    INSERT INTO users(
      email, normalized_email, full_name, email_verified_at, supabase_auth_user_id
    ) VALUES (
      lower(input->>'email'), lower(input->>'email'), input->>'fullName', now(), supplied_auth_id
    ) ON CONFLICT (normalized_email) DO NOTHING RETURNING id INTO target;
    IF target IS NULL THEN
      SELECT id INTO target FROM users
      WHERE normalized_email = lower(input->>'email') FOR UPDATE;
    END IF;
  END IF;
  SELECT status INTO account_status FROM users WHERE id = target FOR UPDATE;
  IF account_status <> 'ACTIVE' THEN RETURN NULL; END IF;
  UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()),
    supabase_auth_user_id = COALESCE(supabase_auth_user_id, supplied_auth_id), updated_at = now()
  WHERE id = target AND (supabase_auth_user_id IS NULL OR supabase_auth_user_id = supplied_auth_id)
  RETURNING id INTO target;
  IF target IS NULL THEN RETURN NULL; END IF;
  INSERT INTO auth_identities(user_id, provider, provider_subject, provider_email)
  VALUES (target, 'GOOGLE', input->>'subject', lower(input->>'email'))
  ON CONFLICT (provider, provider_subject) DO NOTHING;
  SELECT user_id INTO identity_owner FROM auth_identities
  WHERE provider = 'GOOGLE' AND provider_subject = input->>'subject';
  IF identity_owner IS DISTINCT FROM target THEN RAISE unique_violation; END IF;
  RETURN to_jsonb(target);
EXCEPTION WHEN unique_violation OR invalid_text_representation THEN
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION authenti8_upsert_google_user(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_upsert_google_user(JSONB) TO service_role;

INSERT INTO schema_migrations(version) VALUES ('009_supabase_auth_identity_link');
COMMIT;
