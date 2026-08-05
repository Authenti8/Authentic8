BEGIN;

-- BEGIN ONBOARDING BOUNDARY
DROP POLICY authenti8_backend_organization_insert ON organizations;
CREATE POLICY authenti8_backend_organization_insert ON organizations
  FOR INSERT TO authenti8_backend
  WITH CHECK (
    id = NULLIF(current_setting('app.onboarding_organization_id', true), '')::UUID
    AND NULLIF(current_setting('app.user_id', true), '') IS NOT NULL
  );

DROP POLICY authenti8_backend_membership_insert ON organization_members;
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
-- END ONBOARDING BOUNDARY

INSERT INTO schema_migrations(version) VALUES ('004_onboarding_boundary');

COMMIT;
