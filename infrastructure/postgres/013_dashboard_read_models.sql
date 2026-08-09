BEGIN;

CREATE OR REPLACE FUNCTION authenti8_dashboard_overview(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID; billing JSONB; stats JSONB; connected BOOLEAN;
BEGIN
  org := authenti8_user_organization((input->>'userId')::UUID);
  IF org IS NULL THEN RETURN NULL; END IF;
  billing := authenti8_billing_summary(input);
  SELECT jsonb_build_object(
    'upcoming', count(*) FILTER (WHERE scheduled_start >= now()
      AND status NOT IN ('CANCELLED', 'EXCLUDED')),
    'completed', count(*) FILTER (WHERE status IN
      ('COMPLETED', 'MEETING_COMPLETED', 'REPORT_PROCESSING', 'REPORT_READY')),
    'confirmed', count(*) FILTER (WHERE detection_result = 'CONFIRMED'),
    'failed', count(*) FILTER (WHERE status IN ('FAILED', 'SYNC_FAILED'))
  ) INTO stats FROM interviews WHERE organization_id = org;
  SELECT EXISTS(
    SELECT 1 FROM google_integrations integration
    JOIN calendar_sync_states sync ON sync.google_integration_id = integration.id
    WHERE integration.organization_id = org AND integration.status = 'ACTIVE'
      AND sync.last_synced_at IS NOT NULL AND sync.last_error_code IS NULL
  ) INTO connected;
  RETURN billing || stats || jsonb_build_object('integrationActive', connected,
    'recentReports', COALESCE((SELECT jsonb_agg(item) FROM (SELECT jsonb_build_object(
      'interviewId', interview.id, 'title', interview.title,
      'result', report.detection_result, 'generatedAt', report.generated_at) AS item
      FROM reports report JOIN interviews interview ON interview.id = report.interview_id
      WHERE interview.organization_id = org ORDER BY report.generated_at DESC LIMIT 5
    ) recent), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION authenti8_list_interviews(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'title', title,
    'candidateEmail', candidate_email, 'scheduledStart', scheduled_start,
    'scheduledEnd', scheduled_end, 'status', status, 'meetUrl', google_meet_url)
    ORDER BY scheduled_start), '[]'::jsonb)
  FROM interviews interview
  WHERE organization_id = authenti8_user_organization((input->>'userId')::UUID)
    AND ((scheduled_start >= now() - interval '30 days' AND status <> 'EXCLUDED')
      OR EXISTS (SELECT 1 FROM reports report WHERE report.interview_id = interview.id))
$$;

REVOKE ALL ON FUNCTION authenti8_dashboard_overview(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_list_interviews(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_dashboard_overview(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION authenti8_list_interviews(JSONB) TO service_role;

INSERT INTO schema_migrations(version) VALUES ('013_dashboard_read_models');
COMMIT;
