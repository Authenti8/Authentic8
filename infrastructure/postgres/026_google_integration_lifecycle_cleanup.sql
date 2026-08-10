BEGIN;

CREATE OR REPLACE FUNCTION authenti8_cleanup_replaced_google_calendar() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.status = 'ACTIVE' AND (
    NEW.status <> 'ACTIVE'
    OR OLD.selected_calendar_id IS DISTINCT FROM NEW.selected_calendar_id
    OR OLD.google_subject IS DISTINCT FROM NEW.google_subject
  ) THEN
    WITH stale AS (
      UPDATE interviews SET status = 'EXCLUDED', updated_at = now()
      WHERE organization_id = OLD.organization_id
        AND google_calendar_id = OLD.selected_calendar_id
        AND monitoring_started_at IS NULL
        AND status IN ('DETECTED', 'PROTECTED', 'VERIFICATION_SCHEDULED',
          'WAITING_FOR_CANDIDATE', 'CONSENT_PENDING', 'SYNC_FAILED',
          'NO_CREDITS', 'SUBSCRIPTION_INACTIVE', 'UNABLE_TO_VERIFY')
      RETURNING id
    )
    UPDATE credit_reservations reservation
    SET status = 'RELEASED', released_at = now(), release_reason = 'INELIGIBLE'
    FROM stale
    WHERE reservation.interview_id = stale.id AND reservation.status = 'RESERVED';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS authenti8_google_calendar_lifecycle_cleanup ON google_integrations;
CREATE TRIGGER authenti8_google_calendar_lifecycle_cleanup
AFTER UPDATE OF status, selected_calendar_id, google_subject ON google_integrations
FOR EACH ROW EXECUTE FUNCTION authenti8_cleanup_replaced_google_calendar();

REVOKE ALL ON FUNCTION authenti8_cleanup_replaced_google_calendar()
  FROM PUBLIC, anon, authenticated;

INSERT INTO schema_migrations(version) VALUES ('026_google_integration_lifecycle_cleanup')
ON CONFLICT (version) DO NOTHING;
COMMIT;
