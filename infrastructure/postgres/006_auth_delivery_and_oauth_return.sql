BEGIN;

ALTER TABLE oauth_states
  ADD COLUMN IF NOT EXISTS return_path TEXT;

-- BEGIN AUTH EMAIL OUTBOX
CREATE TABLE IF NOT EXISTS auth_email_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('verify', 'reset')),
  encrypted_token TEXT,
  initialization_vector TEXT,
  authentication_tag TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    status IN ('SENT', 'FAILED')
    OR (encrypted_token IS NOT NULL
      AND initialization_vector IS NOT NULL
      AND authentication_tag IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS auth_email_outbox_delivery_idx
  ON auth_email_outbox(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS auth_email_outbox_terminal_cleanup_idx
  ON auth_email_outbox(status, created_at)
  WHERE status IN ('SENT', 'FAILED');
-- END AUTH EMAIL OUTBOX

-- BEGIN AUTH DELIVERY RLS
ALTER TABLE auth_email_outbox ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_email_outbox TO authenti8_backend;
DROP POLICY IF EXISTS authenti8_backend_auth_access ON auth_email_outbox;
CREATE POLICY authenti8_backend_auth_access ON auth_email_outbox
  FOR ALL TO authenti8_backend USING (true) WITH CHECK (true);
-- END AUTH DELIVERY RLS

INSERT INTO schema_migrations(version)
VALUES ('006_auth_delivery_and_oauth_return');

COMMIT;
