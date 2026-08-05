BEGIN;

ALTER TABLE email_verification_tokens
  ADD COLUMN IF NOT EXISTS pending_password_hash TEXT,
  ADD COLUMN IF NOT EXISTS pending_full_name TEXT;

-- Older tokens cannot safely activate a password that was stored before ownership proof.
DELETE FROM email_verification_tokens
WHERE pending_password_hash IS NULL
   OR pending_full_name IS NULL;

-- Existing unverified passwords were accepted before ownership was proven.
UPDATE users
SET password_hash = NULL, updated_at = now()
WHERE email_verified_at IS NULL AND password_hash IS NOT NULL;

ALTER TABLE email_verification_tokens
  ALTER COLUMN pending_password_hash SET NOT NULL,
  ALTER COLUMN pending_full_name SET NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('005_signup_verification_binding');

COMMIT;
