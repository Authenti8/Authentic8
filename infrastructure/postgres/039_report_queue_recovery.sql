BEGIN;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN feature_not_supported OR undefined_file THEN
  RAISE NOTICE 'pg_trgm is unavailable; skipping the candidate-search index';
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX interviews_candidate_search_trgm_idx ON interviews USING GIN '
      || '(lower(organization_id::TEXT || '' '' || COALESCE(candidate_name, '''') '
      || '|| '' '' || candidate_email) gin_trgm_ops)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION authenti8_fail_exhausted_report() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'FAILED' AND NEW.attempts >= 5
      AND (OLD.status, OLD.attempts) IS DISTINCT FROM (NEW.status, NEW.attempts) THEN
    PERFORM authenti8_transition_interview(NEW.interview_id,
      ARRAY['MEETING_COMPLETED'], 'REPORT_PROCESSING', 'REPORT_GENERATION_EXHAUSTED');
    PERFORM authenti8_transition_interview(NEW.interview_id,
      ARRAY['REPORT_PROCESSING'], 'FAILED', 'REPORT_GENERATION_EXHAUSTED');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER authenti8_report_job_terminal_failure
AFTER UPDATE OF status, attempts ON report_generation_jobs FOR EACH ROW
EXECUTE FUNCTION authenti8_fail_exhausted_report();

REVOKE ALL ON FUNCTION authenti8_fail_exhausted_report()
  FROM PUBLIC, anon, authenticated;

INSERT INTO report_generation_jobs(interview_id, available_at)
SELECT interview.id, COALESCE(interview.monitoring_ended_at,
  interview.scheduled_end, now()) + interval '30 seconds'
FROM interviews interview
WHERE interview.status = 'MEETING_COMPLETED' AND interview.report_id IS NULL
ON CONFLICT (interview_id) DO NOTHING;

INSERT INTO schema_migrations(version) VALUES ('039_report_queue_recovery')
  ON CONFLICT DO NOTHING;
COMMIT;
