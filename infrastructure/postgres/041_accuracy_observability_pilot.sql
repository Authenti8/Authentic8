BEGIN;
ALTER TABLE interviews ADD COLUMN correlation_id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX interviews_correlation_idx ON interviews(correlation_id);

CREATE TABLE operational_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  component TEXT NOT NULL CHECK (component IN ('CALENDAR_WEBHOOK', 'OAUTH_REFRESH',
    'REPORT_QUEUE', 'LIVE_STREAM', 'AGENT_ENROLLMENT', 'TELEMETRY_INGESTION',
    'DETECTION_RULE', 'NOTIFICATION_EMAIL')),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  interview_id UUID REFERENCES interviews(id) ON DELETE CASCADE,
  correlation_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  error_code TEXT NOT NULL,
  safe_message TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RETRYING', 'RESOLVED', 'DEAD')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX operational_failures_claim_idx ON operational_failures(status, available_at);
ALTER TABLE operational_failures ENABLE ROW LEVEL SECURITY;

CREATE TABLE accuracy_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL CHECK (platform IN ('WINDOWS', 'MACOS')),
  os_version TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  rule_pack_version TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  true_positives INTEGER NOT NULL CHECK (true_positives >= 0),
  false_positives INTEGER NOT NULL CHECK (false_positives >= 0),
  missed_detections INTEGER NOT NULL CHECK (missed_detections >= 0),
  coverage_failures INTEGER NOT NULL CHECK (coverage_failures >= 0),
  scenario_contract_version TEXT NOT NULL,
  scenarios JSONB NOT NULL CHECK (jsonb_typeof(scenarios) = 'array'),
  artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  attestation_digest TEXT NOT NULL CHECK (attestation_digest ~ '^[0-9a-f]{64}$'),
  attestation_provider TEXT NOT NULL CHECK (attestation_provider = 'HMAC_SHA256'),
  passed BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, os_version, agent_version, rule_pack_version, commit_sha, artifact_digest)
);
ALTER TABLE accuracy_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE pilot_partners (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled_by UUID NOT NULL REFERENCES platform_administrators(user_id),
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ
);
ALTER TABLE pilot_partners ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION authenti8_redact_diagnostic_text(input_value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT left(regexp_replace(regexp_replace(COALESCE(input_value, 'Operation failed'),
    '(?i)(bearer[[:space:]]+)[a-z0-9._~+/=-]+', '\1[REDACTED]', 'g'),
    '(?i)((token|secret|password|authorization|api[_-]?key|cookie)[[:space:]]*[=:][[:space:]]*)[^&[:space:],;]+',
    '\1[REDACTED]', 'g'), 300)
$$;

CREATE OR REPLACE FUNCTION authenti8_redact_diagnostic(input_value JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE item RECORD; result JSONB; normalized TEXT;
BEGIN
  IF jsonb_typeof(input_value) = 'object' THEN
    result := '{}'::JSONB;
    FOR item IN SELECT entry.key, entry.value child FROM jsonb_each(input_value) entry LOOP
      normalized := regexp_replace(lower(item.key), '[^a-z0-9]', '', 'g');
      result := result || jsonb_build_object(item.key, CASE WHEN normalized ~
        '(token|secret|password|credential|authorization|apikey|privatekey|cookie|signature|certificate)'
        THEN '"[REDACTED]"'::JSONB ELSE authenti8_redact_diagnostic(item.child) END);
    END LOOP;
    RETURN result;
  ELSIF jsonb_typeof(input_value) = 'array' THEN
    SELECT COALESCE(jsonb_agg(authenti8_redact_diagnostic(element)), '[]'::JSONB)
      INTO result FROM jsonb_array_elements(input_value) element;
    RETURN result;
  ELSIF jsonb_typeof(input_value) = 'string' THEN
    RETURN to_jsonb(authenti8_redact_diagnostic_text(input_value #>> '{}'));
  END IF;
  RETURN input_value;
END $$;

CREATE OR REPLACE FUNCTION authenti8_record_operational_failure(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE correlation UUID; failure_id UUID; stored_correlation UUID; supplied_organization UUID;
  resolved_organization UUID; supplied_interview UUID;
BEGIN
  supplied_interview := NULLIF(input->>'interviewId', '')::UUID;
  supplied_organization := NULLIF(input->>'organizationId', '')::UUID;
  IF supplied_interview IS NOT NULL THEN
    SELECT interview.correlation_id, interview.organization_id
      INTO correlation, resolved_organization FROM interviews interview
      WHERE interview.id = supplied_interview;
    IF resolved_organization IS NULL OR (supplied_organization IS NOT NULL
        AND supplied_organization <> resolved_organization) THEN
      RETURN jsonb_build_object('recorded', false, 'reason', 'INVALID_FAILURE'); END IF;
  ELSE resolved_organization := supplied_organization; END IF;
  correlation := COALESCE(correlation, NULLIF(input->>'correlationId', '')::UUID, gen_random_uuid());
  INSERT INTO operational_failures(component, organization_id, interview_id, correlation_id,
    idempotency_key, error_code, safe_message, context)
  VALUES (input->>'component', resolved_organization,
    supplied_interview, correlation, input->>'idempotencyKey',
    input->>'errorCode', authenti8_redact_diagnostic_text(input->>'safeMessage'),
    authenti8_redact_diagnostic(COALESCE(input->'context', '{}'::JSONB)))
  ON CONFLICT (idempotency_key) DO UPDATE SET last_seen_at = now(),
    status = CASE WHEN operational_failures.status IN ('DEAD', 'RETRYING')
      THEN operational_failures.status ELSE 'OPEN' END,
    lease_until = CASE WHEN operational_failures.status = 'RETRYING'
      THEN operational_failures.lease_until ELSE NULL END,
    available_at = CASE WHEN operational_failures.status IN ('DEAD', 'RETRYING')
      THEN operational_failures.available_at ELSE now() END,
    safe_message = EXCLUDED.safe_message,
    context = operational_failures.context || EXCLUDED.context
    WHERE operational_failures.component = EXCLUDED.component
      AND operational_failures.organization_id IS NOT DISTINCT FROM EXCLUDED.organization_id
      AND operational_failures.interview_id IS NOT DISTINCT FROM EXCLUDED.interview_id
    RETURNING id, correlation_id INTO failure_id, stored_correlation;
  IF failure_id IS NULL THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'IDEMPOTENCY_CONFLICT'); END IF;
  RETURN jsonb_build_object('recorded', true, 'id', failure_id,
    'correlationId', stored_correlation);
EXCEPTION WHEN check_violation OR invalid_text_representation OR not_null_violation THEN
  RETURN jsonb_build_object('recorded', false, 'reason', 'INVALID_FAILURE');
END $$;

CREATE OR REPLACE FUNCTION authenti8_capture_queue_failure() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE interview UUID; organization UUID; reference TEXT; component_name TEXT;
  code TEXT; message TEXT; diagnostic JSONB := '{}'::JSONB;
BEGIN
  IF TG_TABLE_NAME = 'report_generation_jobs' THEN
    IF NEW.status NOT IN ('PENDING', 'FAILED') OR NEW.last_error IS NULL
        OR (OLD.status, OLD.attempts, OLD.last_error) IS NOT DISTINCT FROM
          (NEW.status, NEW.attempts, NEW.last_error) THEN RETURN NEW; END IF;
    interview := NEW.interview_id; reference := NEW.interview_id::TEXT;
    component_name := 'REPORT_QUEUE'; code := 'REPORT_GENERATION_FAILED';
    message := NEW.last_error;
  ELSIF TG_TABLE_NAME = 'calendar_sync_jobs' THEN
    IF NEW.last_error_code IS NULL OR NEW.last_error_code = OLD.last_error_code THEN RETURN NEW; END IF;
    SELECT integration.organization_id INTO organization FROM google_integrations integration
      WHERE integration.id = NEW.google_integration_id;
    reference := NEW.google_integration_id::TEXT; component_name := 'CALENDAR_WEBHOOK';
    code := NEW.last_error_code; message := NEW.last_error_code;
    diagnostic := jsonb_build_object('googleIntegrationId', NEW.google_integration_id);
  ELSE
    IF NEW.status NOT IN ('PENDING', 'FAILED') OR NEW.last_error IS NULL
        OR (OLD.status, OLD.attempts, OLD.last_error) IS NOT DISTINCT FROM
          (NEW.status, NEW.attempts, NEW.last_error) THEN RETURN NEW; END IF;
    SELECT notice.interview_id, notice.organization_id INTO interview, organization
      FROM workspace_notifications notice WHERE notice.id = NEW.notification_id;
    reference := NEW.notification_id::TEXT; component_name := 'NOTIFICATION_EMAIL';
    code := 'NOTIFICATION_DELIVERY_FAILED'; message := NEW.last_error;
    diagnostic := jsonb_build_object('notificationId', NEW.notification_id);
  END IF;
  IF interview IS NOT NULL THEN SELECT source.organization_id INTO organization
    FROM interviews source WHERE source.id = interview; END IF;
  PERFORM authenti8_record_operational_failure(jsonb_build_object('component', component_name,
    'organizationId', organization, 'interviewId', interview,
    'idempotencyKey', component_name || ':' || reference, 'errorCode', code,
    'safeMessage', COALESCE(message, code), 'context', diagnostic));
  RETURN NEW;
END $$;

CREATE TRIGGER authenti8_report_job_failure_observed AFTER UPDATE ON report_generation_jobs
FOR EACH ROW EXECUTE FUNCTION authenti8_capture_queue_failure();
CREATE TRIGGER authenti8_calendar_job_failure_observed AFTER UPDATE ON calendar_sync_jobs
FOR EACH ROW EXECUTE FUNCTION authenti8_capture_queue_failure();
CREATE TRIGGER authenti8_notification_failure_observed AFTER UPDATE ON notification_email_outbox
FOR EACH ROW EXECUTE FUNCTION authenti8_capture_queue_failure();

CREATE OR REPLACE FUNCTION authenti8_schedule_operational_retry(failure_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE item operational_failures; reference UUID;
BEGIN
  SELECT * INTO item FROM operational_failures WHERE id = failure_id;
  IF item.id IS NULL THEN RETURN false; END IF;
  IF item.component = 'REPORT_QUEUE' AND item.interview_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM reports WHERE interview_id = item.interview_id) THEN RETURN true; END IF;
    INSERT INTO report_generation_jobs(interview_id, available_at, status)
    VALUES (item.interview_id, now(), 'PENDING') ON CONFLICT (interview_id) DO UPDATE SET
      status = 'PENDING', attempts = 0, lease_until = NULL, last_error = NULL,
      available_at = now(), updated_at = now()
      WHERE report_generation_jobs.status <> 'COMPLETED';
    RETURN FOUND;
  ELSIF item.component IN ('CALENDAR_WEBHOOK', 'OAUTH_REFRESH') THEN
    reference := NULLIF(item.context->>'googleIntegrationId', '')::UUID;
    INSERT INTO calendar_sync_jobs(google_integration_id, connection_generation)
    SELECT id, connection_generation FROM google_integrations WHERE id = reference AND status = 'ACTIVE'
    ON CONFLICT (google_integration_id) DO UPDATE SET
      connection_generation = EXCLUDED.connection_generation,
      locked_at = NULL, lock_token = NULL, attempt_count = 0,
      available_at = now(), updated_at = now();
    RETURN FOUND;
  ELSIF item.component = 'NOTIFICATION_EMAIL' THEN
    reference := NULLIF(item.context->>'notificationId', '')::UUID;
    IF EXISTS (SELECT 1 FROM notification_email_outbox
        WHERE notification_id = reference AND status = 'SENT') THEN RETURN true; END IF;
    UPDATE notification_email_outbox SET status = 'PENDING', attempts = 0,
      lease_until = NULL, available_at = now(), last_error = NULL
      WHERE notification_id = reference AND status <> 'SENT';
    RETURN FOUND;
  END IF;
  RETURN false;
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION authenti8_resolve_recovered_operation() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME = 'report_generation_jobs' AND NEW.status = 'COMPLETED' THEN
    UPDATE operational_failures SET status = 'RESOLVED', lease_until = NULL
      WHERE component = 'REPORT_QUEUE' AND interview_id = NEW.interview_id
        AND status = 'RETRYING';
  ELSIF TG_TABLE_NAME = 'notification_email_outbox' AND NEW.status = 'SENT' THEN
    UPDATE operational_failures SET status = 'RESOLVED', lease_until = NULL
      WHERE component = 'NOTIFICATION_EMAIL' AND status = 'RETRYING'
        AND context->>'notificationId' = NEW.notification_id::TEXT;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER authenti8_report_retry_completed
AFTER UPDATE OF status ON report_generation_jobs FOR EACH ROW
WHEN (NEW.status = 'COMPLETED') EXECUTE FUNCTION authenti8_resolve_recovered_operation();
CREATE TRIGGER authenti8_notification_retry_completed
AFTER UPDATE OF status ON notification_email_outbox FOR EACH ROW
WHEN (NEW.status = 'SENT') EXECUTE FUNCTION authenti8_resolve_recovered_operation();

CREATE OR REPLACE FUNCTION authenti8_resolve_calendar_recovery() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE operational_failures SET status = 'RESOLVED', lease_until = NULL
    WHERE component IN ('CALENDAR_WEBHOOK', 'OAUTH_REFRESH') AND status = 'RETRYING'
      AND context->>'googleIntegrationId' = OLD.google_integration_id::TEXT
      AND OLD.lock_token IS NOT NULL AND EXISTS (SELECT 1 FROM google_integrations integration
        WHERE integration.id = OLD.google_integration_id AND integration.status = 'ACTIVE'
          AND integration.connection_generation = OLD.connection_generation);
  RETURN OLD;
END $$;

CREATE TRIGGER authenti8_calendar_retry_completed
AFTER DELETE ON calendar_sync_jobs FOR EACH ROW
EXECUTE FUNCTION authenti8_resolve_calendar_recovery();

CREATE OR REPLACE FUNCTION authenti8_recover_operations(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE item RECORD; retried INTEGER := 0; dead INTEGER := 0;
BEGIN
  FOR item IN SELECT * FROM operational_failures WHERE status IN ('OPEN', 'RETRYING')
      AND available_at <= now() AND (lease_until IS NULL OR lease_until <= now())
    ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 50 LOOP
    IF item.component IN ('LIVE_STREAM', 'AGENT_ENROLLMENT', 'TELEMETRY_INGESTION',
        'DETECTION_RULE') THEN
      IF item.last_seen_at <= now() - interval '5 minutes' THEN UPDATE operational_failures
        SET status = 'RESOLVED', lease_until = NULL WHERE id = item.id;
      ELSE
        UPDATE operational_failures SET status = 'OPEN', lease_until = NULL,
          available_at = item.last_seen_at + interval '5 minutes' WHERE id = item.id;
      END IF; CONTINUE;
    END IF;
    IF (item.component = 'REPORT_QUEUE' AND EXISTS
        (SELECT 1 FROM reports WHERE interview_id = item.interview_id))
      OR (item.component = 'NOTIFICATION_EMAIL' AND EXISTS
        (SELECT 1 FROM notification_email_outbox WHERE status = 'SENT'
          AND notification_id::TEXT = item.context->>'notificationId')) THEN
      UPDATE operational_failures SET status = 'RESOLVED', lease_until = NULL WHERE id = item.id;
      CONTINUE;
    END IF;
    IF item.attempts >= 5 OR NOT authenti8_schedule_operational_retry(item.id) THEN
      UPDATE operational_failures SET status = 'DEAD', lease_until = NULL WHERE id = item.id;
      INSERT INTO audit_logs(organization_id, action, target_type, target_id, reason, new_value,
        correlation_id) VALUES (item.organization_id, 'OPERATION_DEAD_LETTERED',
        item.component, item.id::TEXT, item.safe_message,
        jsonb_build_object('errorCode', item.error_code, 'attempts', item.attempts,
          'recoveryHandlerAttempted', item.attempts < 5),
        item.correlation_id);
      dead := dead + 1;
    ELSE
      UPDATE operational_failures SET status = 'RETRYING', attempts = attempts + 1,
        lease_until = now() + interval '15 minutes', available_at = now() + interval '15 minutes'
        WHERE id = item.id;
      retried := retried + 1;
    END IF;
  END LOOP; UPDATE report_generation_jobs SET status = 'PENDING', lease_until = NULL, updated_at = now()
    WHERE status = 'FAILED' AND attempts < 5 AND available_at <= now();
  UPDATE calendar_sync_jobs SET locked_at = NULL, lock_token = NULL,
    available_at = now(), updated_at = now()
    WHERE locked_at IS NOT NULL AND locked_at <= now() - interval '5 minutes'
      AND attempt_count < 5;
  RETURN jsonb_build_object('retriesScheduled', retried, 'deadLettered', dead);
END $$;

CREATE OR REPLACE FUNCTION authenti8_complete_operational_failure(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed INTEGER; dead_failure operational_failures;
BEGIN
  UPDATE operational_failures SET status = CASE WHEN COALESCE((input->>'success')::BOOLEAN, false)
      THEN 'RESOLVED' WHEN attempts >= 5 THEN 'DEAD' ELSE 'OPEN' END,
    lease_until = NULL, available_at = CASE
      WHEN COALESCE((input->>'success')::BOOLEAN, false) OR attempts >= 5 THEN available_at
      ELSE now() + LEAST(300, 5 * power(2, attempts)) * interval '1 second' END,
    safe_message = CASE WHEN COALESCE((input->>'success')::BOOLEAN, false)
      THEN safe_message ELSE authenti8_redact_diagnostic_text(
        COALESCE(input->>'safeMessage', safe_message)) END
    WHERE id = (input->>'id')::UUID AND status = 'RETRYING'
    RETURNING * INTO dead_failure;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF dead_failure.status = 'DEAD' THEN
    INSERT INTO audit_logs(organization_id, action, target_type, target_id, reason, new_value,
      correlation_id) VALUES (dead_failure.organization_id, 'OPERATION_DEAD_LETTERED',
      dead_failure.component, dead_failure.id::TEXT, dead_failure.safe_message,
      jsonb_build_object('errorCode', dead_failure.error_code,
        'attempts', dead_failure.attempts, 'recoveryHandlerAttempted', true),
      dead_failure.correlation_id);
  END IF;
  RETURN jsonb_build_object('updated', changed = 1);
EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('updated', false);
END $$;

CREATE OR REPLACE FUNCTION authenti8_record_accuracy_run(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE scenarios JSONB := input->'scenarios'; tp INTEGER; fp INTEGER; missed INTEGER;
  coverage INTEGER; run_id UUID; passed BOOLEAN; expected_ids TEXT[]; supplied_ids TEXT[];
  stored_attestation TEXT; stored_passed BOOLEAN; stored_tp INTEGER; stored_fp INTEGER;
  stored_missed INTEGER; stored_coverage INTEGER;
BEGIN
  IF input->>'evidenceSource' <> 'NATIVE_E2E'
      OR NULLIF(input->>'artifactDigest', '') IS NULL
      OR NULLIF(input->>'attestationDigest', '') IS NULL THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'NATIVE_EVIDENCE_REQUIRED'); END IF;
  IF jsonb_typeof(scenarios) <> 'array' OR jsonb_array_length(scenarios) = 0 THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'SCENARIOS_REQUIRED'); END IF;
  IF input->>'scenarioContractVersion' <> 'pilot-v1' THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'INVALID_SCENARIO_CONTRACT'); END IF;
  expected_ids := CASE input->>'platform'
    WHEN 'WINDOWS' THEN ARRAY['accessibility-noise-removal','benign-virtual-audio',
      'capture-excluded-overlay','cluely-active','google-meet','hidden-overlay','notion-vscode',
      'parakeet-active','recorders-password-managers','slack-teams-zoom',
      'supported-extension-active','virtual-audio-ai']
    WHEN 'MACOS' THEN ARRAY['accessibility-noise-removal','benign-virtual-audio','cluely-active',
      'hidden-overlay','meet-slack-teams-zoom','notion-vscode','parakeet-active',
      'recorders-password-managers','virtual-audio-ai'] ELSE NULL END;
  SELECT array_agg(item->>'id' ORDER BY item->>'id') INTO supplied_ids
    FROM jsonb_array_elements(scenarios) item;
  IF expected_ids IS NULL OR supplied_ids IS DISTINCT FROM expected_ids
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(scenarios) item
        WHERE item->>'expected' NOT IN ('CONFIRMED', 'NOT_DETECTED')
          OR item->>'actual' NOT IN ('CONFIRMED', 'NOT_DETECTED', 'UNABLE_TO_VERIFY')
          OR jsonb_typeof(item->'coverageHealthy') <> 'boolean'
          OR item->>'expected' IS DISTINCT FROM CASE
            WHEN input->>'platform' = 'WINDOWS' AND item->>'id' = ANY (ARRAY[
              'capture-excluded-overlay','cluely-active','hidden-overlay','parakeet-active',
              'supported-extension-active','virtual-audio-ai']) THEN 'CONFIRMED'
            WHEN input->>'platform' = 'MACOS' AND item->>'id' = ANY (ARRAY[
              'cluely-active','hidden-overlay','parakeet-active','virtual-audio-ai'])
              THEN 'CONFIRMED' ELSE 'NOT_DETECTED' END) THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'INCOMPLETE_SCENARIO_SET'); END IF;
  SELECT count(*) FILTER (WHERE expected = 'CONFIRMED' AND actual = 'CONFIRMED'),
    count(*) FILTER (WHERE expected = 'NOT_DETECTED' AND actual = 'CONFIRMED'),
    count(*) FILTER (WHERE expected = 'CONFIRMED' AND actual <> 'CONFIRMED'),
    count(*) FILTER (WHERE coverage_healthy = false)
  INTO tp, fp, missed, coverage FROM (SELECT item->>'expected' expected,
    item->>'actual' actual, COALESCE((item->>'coverageHealthy')::BOOLEAN, false) coverage_healthy
    FROM jsonb_array_elements(scenarios) item) result;
  passed := fp = 0 AND missed = 0 AND coverage = 0;
  INSERT INTO accuracy_runs(platform, os_version, agent_version, rule_pack_version, commit_sha,
    true_positives, false_positives, missed_detections, coverage_failures,
    scenario_contract_version, scenarios,
    artifact_digest, attestation_digest, attestation_provider, passed)
  VALUES (input->>'platform', input->>'osVersion', input->>'agentVersion',
    input->>'rulePackVersion', input->>'commitSha', tp, fp, missed, coverage,
    input->>'scenarioContractVersion', scenarios,
    input->>'artifactDigest', input->>'attestationDigest', input->>'attestationProvider', passed)
  ON CONFLICT (platform, os_version, agent_version, rule_pack_version, commit_sha,
    artifact_digest) DO NOTHING
  RETURNING id INTO run_id;
  IF run_id IS NULL THEN
    SELECT id, attestation_digest, accuracy_runs.passed, true_positives, false_positives,
      missed_detections, coverage_failures INTO run_id, stored_attestation, stored_passed,
      stored_tp, stored_fp, stored_missed, stored_coverage FROM accuracy_runs
      WHERE platform = input->>'platform'
      AND os_version = input->>'osVersion' AND agent_version = input->>'agentVersion'
      AND rule_pack_version = input->>'rulePackVersion' AND commit_sha = input->>'commitSha'
      AND artifact_digest = input->>'artifactDigest';
    IF stored_attestation IS DISTINCT FROM input->>'attestationDigest' THEN
      RETURN jsonb_build_object('recorded', false, 'reason', 'ATTESTATION_CONFLICT'); END IF;
    passed := stored_passed; tp := stored_tp; fp := stored_fp;
    missed := stored_missed; coverage := stored_coverage;
  END IF;
  RETURN jsonb_build_object('recorded', true, 'runId', run_id, 'passed', passed,
    'truePositives', tp, 'falsePositives', fp, 'missedDetections', missed,
    'coverageFailures', coverage);
EXCEPTION WHEN check_violation OR invalid_text_representation OR not_null_violation THEN
  RETURN jsonb_build_object('recorded', false, 'reason', 'INVALID_RUN');
END $$;

CREATE OR REPLACE FUNCTION authenti8_register_application_version(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE existing_commit TEXT; existing_digest TEXT; requested_minimum BOOLEAN :=
  COALESCE((input->>'minimumSupported')::BOOLEAN, false);
BEGIN
  LOCK TABLE application_versions IN SHARE ROW EXCLUSIVE MODE;
  SELECT source_commit_sha, artifact_digest INTO existing_commit, existing_digest
    FROM application_versions
    WHERE application = input->>'application' AND platform = input->>'platform'
      AND version = input->>'version' AND release_channel = input->>'releaseChannel';
  IF existing_commit IS NOT NULL AND (existing_commit <> input->>'commitSha'
      OR existing_digest <> input->>'artifactDigest') THEN
    RETURN jsonb_build_object('registered', false, 'reason', 'VERSION_COMMIT_CONFLICT'); END IF;
  INSERT INTO application_versions(application, platform, version, release_channel,
    source_commit_sha, artifact_digest, minimum_supported)
  VALUES (input->>'application', input->>'platform', input->>'version', input->>'releaseChannel',
    input->>'commitSha', input->>'artifactDigest',
    requested_minimum)
  ON CONFLICT (application, platform, version, release_channel) DO UPDATE SET
    minimum_supported = EXCLUDED.minimum_supported, released_at = now()
    WHERE application_versions.source_commit_sha = EXCLUDED.source_commit_sha
      AND application_versions.artifact_digest = EXCLUDED.artifact_digest;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('registered', false, 'reason', 'VERSION_COMMIT_CONFLICT'); END IF;
  IF requested_minimum THEN UPDATE application_versions SET minimum_supported =
    application_versions.version = input->>'version' WHERE application = input->>'application'
      AND platform = input->>'platform' AND release_channel = input->>'releaseChannel'; END IF;
  RETURN jsonb_build_object('registered', true);
EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation THEN
  RETURN jsonb_build_object('registered', false, 'reason', 'INVALID_VERSION');
END $$;

CREATE OR REPLACE FUNCTION authenti8_pilot_readiness(input JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; checks JSONB; ready BOOLEAN;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_administrators WHERE user_id = actor) THEN RETURN NULL; END IF;
  checks := jsonb_build_array(
    jsonb_build_object('key', 'accuracy-windows', 'passed', EXISTS (SELECT 1
      FROM application_versions version JOIN accuracy_runs run
        ON run.platform = 'WINDOWS' AND run.os_version = 'Windows 11'
        AND run.agent_version = version.version
        AND run.commit_sha = version.source_commit_sha
        AND run.artifact_digest = version.artifact_digest AND run.passed
      JOIN detection_rule_packs pack ON pack.platform = 'WINDOWS'
        AND pack.version = run.rule_pack_version AND pack.disabled_at IS NULL
        AND pack.expires_at > now()
      WHERE version.application = 'WINDOWS_AGENT' AND version.platform = 'WINDOWS'
        AND version.release_channel = 'PRODUCTION' AND version.minimum_supported)),
    jsonb_build_object('key', 'accuracy-macos', 'passed', EXISTS (SELECT 1
      FROM application_versions version JOIN accuracy_runs run
        ON run.platform = 'MACOS' AND run.os_version = 'macOS 15'
        AND run.agent_version = version.version
        AND run.commit_sha = version.source_commit_sha
        AND run.artifact_digest = version.artifact_digest AND run.passed
      JOIN detection_rule_packs pack ON pack.platform = 'MACOS'
        AND pack.version = run.rule_pack_version AND pack.disabled_at IS NULL
        AND pack.expires_at > now()
      WHERE version.application = 'MACOS_AGENT' AND version.platform = 'MACOS'
        AND version.release_channel = 'PRODUCTION' AND version.minimum_supported)),
    jsonb_build_object('key', 'no-open-dead-letters', 'passed',
      NOT EXISTS (SELECT 1 FROM operational_failures WHERE status = 'DEAD')
      AND NOT EXISTS (SELECT 1 FROM report_generation_jobs
        WHERE status = 'FAILED' AND attempts >= 5)
      AND NOT EXISTS (SELECT 1 FROM notification_email_outbox
        WHERE status = 'FAILED' AND attempts >= 5)
      AND NOT EXISTS (SELECT 1 FROM calendar_sync_jobs WHERE attempt_count >= 5)),
    jsonb_build_object('key', 'active-rule-packs', 'passed', NOT EXISTS (SELECT platform
      FROM (VALUES ('WINDOWS'), ('MACOS'), ('CHROME')) required(platform) WHERE NOT EXISTS
      (SELECT 1 FROM detection_rule_packs pack WHERE pack.platform = required.platform
        AND pack.published_at <= now() AND pack.disabled_at IS NULL AND pack.expires_at > now()))),
    jsonb_build_object('key', 'calendar-connected', 'passed', NOT EXISTS
      (SELECT 1 FROM pilot_partners partner WHERE partner.disabled_at IS NULL AND NOT EXISTS
        (SELECT 1 FROM google_integrations integration
          WHERE integration.organization_id = partner.organization_id
            AND integration.status = 'ACTIVE'))),
    jsonb_build_object('key', 'pilot-partner', 'passed', EXISTS
      (SELECT 1 FROM pilot_partners WHERE disabled_at IS NULL)));
  SELECT bool_and((item->>'passed')::BOOLEAN) INTO ready FROM jsonb_array_elements(checks) item;
  RETURN jsonb_build_object('ready', ready, 'checks', checks, 'checkedAt', now());
END $$;

REVOKE ALL ON FUNCTION authenti8_record_operational_failure(JSONB),
  authenti8_recover_operations(JSONB), authenti8_complete_operational_failure(JSONB),
  authenti8_record_accuracy_run(JSONB), authenti8_register_application_version(JSONB),
  authenti8_pilot_readiness(JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_redact_diagnostic(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_redact_diagnostic_text(TEXT),
  authenti8_schedule_operational_retry(UUID), authenti8_resolve_recovered_operation(),
  authenti8_resolve_calendar_recovery() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_record_operational_failure(JSONB),
  authenti8_recover_operations(JSONB), authenti8_complete_operational_failure(JSONB),
  authenti8_record_accuracy_run(JSONB), authenti8_register_application_version(JSONB),
  authenti8_pilot_readiness(JSONB) TO service_role;

INSERT INTO schema_migrations(version) VALUES ('041_accuracy_observability_pilot') ON CONFLICT DO NOTHING;
COMMIT;
