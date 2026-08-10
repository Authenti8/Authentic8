BEGIN;

CREATE OR REPLACE FUNCTION authenti8_dashboard_overview(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID; billing JSONB; stats JSONB; connected BOOLEAN; notifications INTEGER;
BEGIN
  org := authenti8_user_organization((input->>'userId')::UUID);
  IF org IS NULL THEN RETURN NULL; END IF;
  billing := authenti8_billing_summary(input);
  SELECT jsonb_build_object(
    'upcoming', count(*) FILTER (WHERE scheduled_start >= now()
      AND status IN ('PROTECTED', 'VERIFICATION_SCHEDULED', 'WAITING_FOR_CANDIDATE',
        'CONSENT_PENDING', 'DEVICE_CONNECTING', 'MONITORING_ACTIVE')
      AND protection_status IN ('RESERVED', 'CONSUMED')),
    'completed', count(*) FILTER (WHERE status IN
      ('COMPLETED', 'MEETING_COMPLETED', 'REPORT_PROCESSING', 'REPORT_READY')),
    'confirmed', count(*) FILTER (WHERE detection_result = 'CONFIRMED'),
    'failed', count(*) FILTER (WHERE status IN
      ('FAILED', 'SYNC_FAILED', 'UNABLE_TO_VERIFY', 'MONITORING_INTERRUPTED'))
  ) INTO stats FROM interviews WHERE organization_id = org;
  SELECT count(*)::INTEGER INTO notifications FROM workspace_notifications
    WHERE organization_id = org AND read_at IS NULL;
  SELECT EXISTS(SELECT 1 FROM google_integrations integration
    JOIN calendar_sync_states sync ON sync.google_integration_id = integration.id
    WHERE integration.organization_id = org AND integration.status = 'ACTIVE'
      AND sync.last_synced_at IS NOT NULL AND sync.last_error_code IS NULL) INTO connected;
  RETURN billing || stats || jsonb_build_object('integrationActive', connected,
    'notificationCount', notifications,
    'recentReports', COALESCE((SELECT jsonb_agg(item) FROM (SELECT jsonb_build_object(
      'interviewId', interview.id, 'title', interview.title,
      'result', report.detection_result, 'generatedAt', report.generated_at) AS item
      FROM reports report JOIN interviews interview ON interview.id = report.interview_id
      WHERE interview.organization_id = org ORDER BY report.generated_at DESC LIMIT 5
    ) recent), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION authenti8_acknowledge_notifications(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID; acknowledged INTEGER := 0;
BEGIN
  org := authenti8_user_organization((input->>'userId')::UUID);
  IF org IS NULL THEN RETURN NULL; END IF;
  UPDATE workspace_notifications SET read_at = now()
    WHERE organization_id = org AND read_at IS NULL;
  GET DIAGNOSTICS acknowledged = ROW_COUNT;
  RETURN jsonb_build_object('acknowledged', acknowledged);
END $$;

REVOKE ALL ON FUNCTION authenti8_dashboard_overview(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_acknowledge_notifications(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_dashboard_overview(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION authenti8_acknowledge_notifications(JSONB) TO service_role;

INSERT INTO schema_migrations(version) VALUES ('024_recruiter_lifecycle_notifications')
ON CONFLICT (version) DO NOTHING;
COMMIT;
