BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  normalized_email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  password_hash TEXT,
  email_verified_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('GOOGLE')),
  provider_subject TEXT NOT NULL,
  provider_email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  user_agent_hash TEXT,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_active_idx ON sessions(token_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  pending_password_hash TEXT NOT NULL,
  pending_full_name TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash TEXT NOT NULL UNIQUE,
  verifier TEXT NOT NULL,
  return_path TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_rate_limits (
  key_hash TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  window_started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX auth_rate_limits_expiry_idx ON auth_rate_limits(expires_at);

-- BEGIN AUTH EMAIL OUTBOX
CREATE TABLE auth_email_outbox (
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

CREATE INDEX auth_email_outbox_delivery_idx
  ON auth_email_outbox(status, available_at, created_at);
CREATE INDEX auth_email_outbox_terminal_cleanup_idx
  ON auth_email_outbox(status, created_at)
  WHERE status IN ('SENT', 'FAILED');
-- END AUTH EMAIL OUTBOX

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  company_size TEXT NOT NULL,
  expected_monthly_interviews INTEGER NOT NULL CHECK (
    expected_monthly_interviews >= 0
  ),
  default_timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX organizations_domain_idx ON organizations(lower(domain));

CREATE TABLE organization_members (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'RECRUITER', 'VIEWER')),
  job_role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX organization_members_user_idx ON organization_members(user_id);

CREATE TABLE interview_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('STRICT')),
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE UNIQUE INDEX interview_policies_default_idx
  ON interview_policies(organization_id)
  WHERE is_default;

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT,
  provider_subscription_id TEXT UNIQUE,
  plan_key TEXT NOT NULL DEFAULT 'PILOT',
  status TEXT NOT NULL DEFAULT 'TRIALING',
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  kind TEXT NOT NULL,
  reference_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX credit_transactions_org_idx
  ON credit_transactions(organization_id, created_at DESC);

CREATE TABLE google_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connected_user_id UUID NOT NULL REFERENCES users(id),
  google_subject TEXT NOT NULL,
  connected_email TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  selected_calendar_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, google_subject)
);

CREATE TABLE calendar_sync_states (
  google_integration_id UUID PRIMARY KEY
    REFERENCES google_integrations(id) ON DELETE CASCADE,
  sync_token TEXT,
  channel_id TEXT,
  channel_expires_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  last_error_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE interviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  google_event_id TEXT NOT NULL,
  google_calendar_id TEXT NOT NULL,
  google_meet_code TEXT NOT NULL,
  google_meet_url TEXT NOT NULL,
  candidate_email TEXT NOT NULL,
  candidate_name TEXT,
  organizer_email TEXT NOT NULL,
  title TEXT NOT NULL,
  classification_reason TEXT,
  scheduled_start TIMESTAMPTZ NOT NULL,
  scheduled_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'DETECTED',
  consent_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
  monitoring_started_at TIMESTAMPTZ,
  monitoring_ended_at TIMESTAMPTZ,
  coverage_percentage NUMERIC(5,2),
  detection_result TEXT,
  report_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, google_calendar_id, google_event_id),
  CHECK (scheduled_end > scheduled_start),
  CHECK (coverage_percentage IS NULL OR (
    coverage_percentage >= 0 AND coverage_percentage <= 100
  ))
);

CREATE INDEX interviews_org_schedule_idx
  ON interviews(organization_id, scheduled_start DESC);

CREATE TABLE interview_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id UUID NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  participant_type TEXT NOT NULL,
  is_external BOOLEAN NOT NULL,
  UNIQUE (interview_id, email)
);

CREATE TABLE verification_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id UUID NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  candidate_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  consent_version TEXT,
  consented_at TIMESTAMPTZ,
  eligible_start TIMESTAMPTZ NOT NULL,
  eligible_end TIMESTAMPTZ NOT NULL,
  monitoring_started_at TIMESTAMPTZ,
  monitoring_ended_at TIMESTAMPTZ,
  coverage_percentage NUMERIC(5,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (eligible_end > eligible_start)
);

CREATE TABLE candidate_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_session_id UUID NOT NULL
    REFERENCES verification_sessions(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  platform TEXT NOT NULL,
  platform_version TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX candidate_devices_primary_idx
  ON candidate_devices(verification_session_id)
  WHERE revoked_at IS NULL;

CREATE TABLE agent_heartbeats (
  id BIGSERIAL PRIMARY KEY,
  verification_session_id UUID NOT NULL
    REFERENCES verification_sessions(id) ON DELETE CASCADE,
  sequence_number BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (verification_session_id, sequence_number)
);

CREATE TABLE telemetry_events (
  id UUID PRIMARY KEY,
  verification_session_id UUID NOT NULL
    REFERENCES verification_sessions(id) ON DELETE CASCADE,
  sequence_number BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  event_timestamp TIMESTAMPTZ NOT NULL,
  monotonic_timestamp BIGINT NOT NULL,
  platform TEXT NOT NULL,
  payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  previous_event_hash TEXT,
  agent_version TEXT NOT NULL,
  rule_pack_version TEXT NOT NULL,
  signature TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (verification_session_id, sequence_number)
);

CREATE INDEX telemetry_events_session_idx
  ON telemetry_events(verification_session_id, sequence_number);

CREATE TABLE detection_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key TEXT NOT NULL,
  product_family TEXT NOT NULL,
  platform TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  match_condition JSONB NOT NULL,
  confidence TEXT NOT NULL,
  required_supporting_signals JSONB NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES users(id),
  reviewed_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rule_key, version)
);

CREATE TABLE detection_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_session_id UUID NOT NULL
    REFERENCES verification_sessions(id) ON DELETE CASCADE,
  rule_id UUID NOT NULL REFERENCES detection_rules(id),
  source_event_id UUID NOT NULL REFERENCES telemetry_events(id),
  result TEXT NOT NULL CHECK (result IN ('CONFIRMED')),
  evidence_summary JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id UUID NOT NULL UNIQUE REFERENCES interviews(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  detection_result TEXT NOT NULL,
  monitoring_status TEXT NOT NULL,
  coverage_percentage NUMERIC(5,2) NOT NULL,
  snapshot JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE interviews ADD CONSTRAINT interviews_report_fk
  FOREIGN KEY (report_id) REFERENCES reports(id);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  deduplication_key TEXT NOT NULL UNIQUE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  reason TEXT,
  previous_value JSONB,
  new_value JSONB,
  correlation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_org_created_idx
  ON audit_logs(organization_id, created_at DESC);

DO $$
DECLARE
  protected_table TEXT;
BEGIN
  FOREACH protected_table IN ARRAY ARRAY[
    'schema_migrations', 'users', 'auth_identities', 'sessions',
    'email_verification_tokens', 'password_reset_tokens', 'oauth_states',
    'auth_rate_limits', 'auth_email_outbox', 'organizations', 'organization_members',
    'interview_policies', 'subscriptions', 'credit_transactions',
    'google_integrations', 'calendar_sync_states', 'interviews',
    'interview_participants', 'verification_sessions', 'candidate_devices',
    'agent_heartbeats', 'telemetry_events', 'detection_rules',
    'detection_incidents', 'reports', 'notifications', 'audit_logs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', protected_table);
  END LOOP;
END $$;

INSERT INTO schema_migrations(version) VALUES ('001_initial');

COMMIT;
