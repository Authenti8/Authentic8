BEGIN;

-- BEGIN TENANT BOUNDARIES
ALTER ROLE authenti8_backend
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM authenti8_backend;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM authenti8_backend;

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
    EXECUTE format(
      'DROP POLICY IF EXISTS authenti8_backend_access ON %I',
      protected_table
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION authenti8_has_organization_access(target UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_members
    WHERE organization_id = target
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::UUID
  )
$$;

REVOKE ALL ON FUNCTION authenti8_has_organization_access(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenti8_has_organization_access(UUID)
  TO authenti8_backend;

GRANT SELECT, INSERT, UPDATE ON users TO authenti8_backend;
GRANT SELECT, INSERT ON auth_identities TO authenti8_backend;
GRANT SELECT, INSERT, UPDATE ON sessions TO authenti8_backend;
GRANT SELECT, INSERT, UPDATE ON email_verification_tokens TO authenti8_backend;
GRANT SELECT, INSERT, UPDATE ON password_reset_tokens TO authenti8_backend;
GRANT SELECT, INSERT, UPDATE ON oauth_states TO authenti8_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_limits TO authenti8_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_email_outbox TO authenti8_backend;

CREATE POLICY authenti8_backend_auth_access ON users
  FOR ALL TO authenti8_backend USING (true) WITH CHECK (true);
CREATE POLICY authenti8_backend_auth_access ON auth_identities
  FOR ALL TO authenti8_backend USING (true) WITH CHECK (true);
CREATE POLICY authenti8_backend_auth_access ON sessions
  FOR ALL TO authenti8_backend USING (true) WITH CHECK (true);
CREATE POLICY authenti8_backend_auth_access ON email_verification_tokens
  FOR ALL TO authenti8_backend USING (true) WITH CHECK (true);
CREATE POLICY authenti8_backend_auth_access ON password_reset_tokens
  FOR ALL TO authenti8_backend USING (true) WITH CHECK (true);
CREATE POLICY authenti8_backend_auth_access ON oauth_states
  FOR ALL TO authenti8_backend USING (true) WITH CHECK (true);
CREATE POLICY authenti8_backend_auth_access ON auth_rate_limits
  FOR ALL TO authenti8_backend USING (true) WITH CHECK (true);
CREATE POLICY authenti8_backend_auth_access ON auth_email_outbox
  FOR ALL TO authenti8_backend USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON organizations TO authenti8_backend;
GRANT SELECT, INSERT ON organization_members TO authenti8_backend;
GRANT INSERT ON interview_policies TO authenti8_backend;
GRANT INSERT ON subscriptions TO authenti8_backend;
GRANT INSERT ON credit_transactions TO authenti8_backend;
GRANT INSERT ON audit_logs TO authenti8_backend;

CREATE POLICY authenti8_backend_organization_select ON organizations
  FOR SELECT TO authenti8_backend
  USING (authenti8_has_organization_access(id));
CREATE POLICY authenti8_backend_organization_insert ON organizations
  FOR INSERT TO authenti8_backend
  WITH CHECK (
    id = NULLIF(current_setting('app.onboarding_organization_id', true), '')::UUID
    AND NULLIF(current_setting('app.user_id', true), '') IS NOT NULL
  );

CREATE POLICY authenti8_backend_membership_select ON organization_members
  FOR SELECT TO authenti8_backend
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::UUID);
CREATE POLICY authenti8_backend_membership_insert ON organization_members
  FOR INSERT TO authenti8_backend
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::UUID
    AND organization_id = NULLIF(
      current_setting('app.onboarding_organization_id', true),
      ''
    )::UUID
    AND role = 'OWNER'
  );

CREATE POLICY authenti8_backend_policy_insert ON interview_policies
  FOR INSERT TO authenti8_backend
  WITH CHECK (authenti8_has_organization_access(organization_id));
CREATE POLICY authenti8_backend_subscription_insert ON subscriptions
  FOR INSERT TO authenti8_backend
  WITH CHECK (authenti8_has_organization_access(organization_id));
CREATE POLICY authenti8_backend_credit_insert ON credit_transactions
  FOR INSERT TO authenti8_backend
  WITH CHECK (authenti8_has_organization_access(organization_id));
CREATE POLICY authenti8_backend_audit_insert ON audit_logs
  FOR INSERT TO authenti8_backend
  WITH CHECK (authenti8_has_organization_access(organization_id));
-- END TENANT BOUNDARIES

INSERT INTO schema_migrations(version) VALUES ('003_tenant_boundaries');

COMMIT;
