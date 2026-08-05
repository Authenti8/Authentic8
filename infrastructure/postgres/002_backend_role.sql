BEGIN;

-- BEGIN BACKEND ROLE AND RLS
DO $$
DECLARE
  protected_table TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenti8_backend') THEN
    CREATE ROLE authenti8_backend
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  GRANT USAGE ON SCHEMA public TO authenti8_backend;

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
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO authenti8_backend',
      protected_table
    );
    EXECUTE format(
      'CREATE POLICY authenti8_backend_access ON %I '
      'FOR ALL TO authenti8_backend USING (true) WITH CHECK (true)',
      protected_table
    );
  END LOOP;

  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenti8_backend;
END $$;
-- END BACKEND ROLE AND RLS

INSERT INTO schema_migrations(version) VALUES ('002_backend_role');

COMMIT;
