BEGIN;

CREATE OR REPLACE FUNCTION authenti8_valid_interview_transition(old_status TEXT, new_status TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT old_status = new_status OR CASE old_status
    WHEN 'DETECTED' THEN new_status IN ('PROTECTED','NO_CREDITS','SUBSCRIPTION_INACTIVE','CANCELLED','EXCLUDED','SYNC_FAILED')
    WHEN 'PROTECTED' THEN new_status IN ('VERIFICATION_SCHEDULED','NO_CREDITS','SUBSCRIPTION_INACTIVE','CANCELLED','EXCLUDED')
    WHEN 'VERIFICATION_SCHEDULED' THEN new_status IN ('WAITING_FOR_CANDIDATE','NO_CREDITS','SUBSCRIPTION_INACTIVE','CANCELLED','EXCLUDED','UNABLE_TO_VERIFY')
    WHEN 'WAITING_FOR_CANDIDATE' THEN new_status IN ('CONSENT_PENDING','DETECTED','CANCELLED','EXCLUDED','UNABLE_TO_VERIFY')
    WHEN 'CONSENT_PENDING' THEN new_status IN ('DEVICE_CONNECTING','DETECTED','CONSENT_DECLINED','CANCELLED','EXCLUDED','UNABLE_TO_VERIFY')
    WHEN 'DEVICE_CONNECTING' THEN new_status IN ('DETECTED','MONITORING_ACTIVE','CANCELLED','UNABLE_TO_VERIFY')
    WHEN 'UNABLE_TO_VERIFY' THEN new_status IN ('DETECTED','CANCELLED','EXCLUDED')
    WHEN 'MONITORING_ACTIVE' THEN new_status IN ('MEETING_COMPLETED','MONITORING_INTERRUPTED','CANCELLED')
    WHEN 'MEETING_COMPLETED' THEN new_status = 'REPORT_PROCESSING'
    WHEN 'REPORT_PROCESSING' THEN new_status IN ('REPORT_READY','FAILED')
    WHEN 'FAILED' THEN new_status = 'MEETING_COMPLETED'
    WHEN 'CANCELLED' THEN new_status IN ('DETECTED','EXCLUDED')
    WHEN 'EXCLUDED' THEN new_status IN ('DETECTED','CANCELLED')
    WHEN 'SYNC_FAILED' THEN new_status IN ('DETECTED','CANCELLED','EXCLUDED')
    WHEN 'NO_CREDITS' THEN new_status IN ('DETECTED','CANCELLED','EXCLUDED')
    WHEN 'SUBSCRIPTION_INACTIVE' THEN new_status IN ('DETECTED','CANCELLED','EXCLUDED')
    ELSE false END
$$;

CREATE OR REPLACE FUNCTION authenti8_schedule_operational_retry(failure_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE item operational_failures; reference UUID;
BEGIN
  SELECT * INTO item FROM operational_failures WHERE id = failure_id;
  IF item.id IS NULL THEN RETURN false; END IF;
  IF item.component = 'REPORT_QUEUE' AND item.interview_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM reports WHERE interview_id = item.interview_id) THEN RETURN true; END IF;
    IF NOT authenti8_transition_interview(item.interview_id, ARRAY['FAILED'],
        'MEETING_COMPLETED', 'REPORT_REGENERATION_REQUESTED')
      AND NOT EXISTS (SELECT 1 FROM interviews WHERE id = item.interview_id
        AND status = 'MEETING_COMPLETED') THEN RETURN false; END IF;
    INSERT INTO report_generation_jobs(interview_id, available_at, status)
    VALUES (item.interview_id, now(), 'PENDING') ON CONFLICT (interview_id) DO UPDATE SET
      status = 'PENDING', attempts = 0, lease_until = NULL, last_error = NULL,
      available_at = now(), updated_at = now()
      WHERE report_generation_jobs.status <> 'COMPLETED';
    RETURN FOUND;
  ELSIF item.component IN ('CALENDAR_WEBHOOK', 'OAUTH_REFRESH') THEN
    reference := NULLIF(item.context->>'googleIntegrationId', '')::UUID;
    INSERT INTO calendar_sync_jobs(google_integration_id, connection_generation)
    SELECT id, connection_generation FROM google_integrations
      WHERE id = reference AND status = 'ACTIVE'
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

CREATE OR REPLACE FUNCTION authenti8_admin_overview(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; result JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_administrators WHERE user_id = actor) THEN RETURN NULL; END IF;
  INSERT INTO audit_logs(actor_user_id, action, target_type, reason, new_value)
    VALUES (actor, 'CUSTOMER_DATA_ACCESSED', 'admin_overview', 'Internal support review',
      jsonb_build_object('query', left(COALESCE(input->>'query', ''), 120)));
  SELECT jsonb_build_object('organizations', COALESCE(jsonb_agg(jsonb_build_object(
    'id', org.id, 'name', org.name, 'domain', org.domain, 'status', org.status,
    'subscriptionStatus', subscription.status, 'plan', subscription.plan_key,
    'calendarError', sync.last_error_code, 'activeAgents', (SELECT count(DISTINCT session.id)
      FROM verification_sessions session JOIN agent_heartbeats heartbeat ON heartbeat.verification_session_id = session.id
      JOIN interviews active_interview ON active_interview.id = session.interview_id
      WHERE active_interview.organization_id = org.id AND session.status = 'MONITORING_ACTIVE'
        AND heartbeat.received_at >= now() - interval '15 seconds'),
    'confirmedDetections', (SELECT count(*) FROM detection_incidents incident
      JOIN verification_sessions session ON session.id = incident.verification_session_id
      JOIN interviews detected_interview ON detected_interview.id = session.interview_id
      WHERE detected_interview.organization_id = org.id AND incident.result = 'CONFIRMED'),
    'openDisputes', (SELECT count(*) FROM candidate_disputes dispute
      JOIN interviews interview ON interview.id = dispute.interview_id
      WHERE interview.organization_id = org.id
        AND dispute.status IN ('OPEN', 'REVIEWED')))
    ORDER BY org.created_at DESC), '[]'::JSONB)) INTO result FROM organizations org
  LEFT JOIN LATERAL (SELECT candidate.status, candidate.plan_key FROM subscriptions candidate
    WHERE candidate.organization_id = org.id ORDER BY candidate.updated_at DESC LIMIT 1) subscription ON true
  LEFT JOIN LATERAL (SELECT state.last_error_code FROM google_integrations integration
    JOIN calendar_sync_states state ON state.google_integration_id = integration.id
    WHERE integration.organization_id = org.id AND integration.status = 'ACTIVE'
    ORDER BY state.updated_at DESC LIMIT 1) sync ON true
  WHERE NULLIF(input->>'query', '') IS NULL OR lower(org.name || ' ' || org.domain)
    LIKE '%' || replace(replace(lower(input->>'query'), '%', '\%'), '_', '\_') || '%' ESCAPE '\';
  RETURN result || jsonb_build_object(
    'rulePacks', COALESCE((SELECT jsonb_agg(jsonb_build_object('platform', platform,
      'version', version, 'expiresAt', expires_at, 'disabledAt', disabled_at)
      ORDER BY platform, published_at DESC) FROM detection_rule_packs), '[]'::JSONB),
    'rules', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'ruleKey', rule_key,
      'platform', platform, 'version', version, 'confidence', confidence, 'status', status,
      'enabled', enabled) ORDER BY platform, rule_key, version DESC) FROM detection_rules), '[]'::JSONB),
    'applicationVersions', COALESCE((SELECT jsonb_agg(to_jsonb(version) ORDER BY released_at DESC)
      FROM application_versions version), '[]'::JSONB),
    'pendingChanges', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'action', action,
      'targetId', target_id, 'reason', reason, 'requestedBy', requested_by, 'payload', payload,
      'createdAt', created_at) ORDER BY created_at) FROM admin_change_requests
      WHERE status = 'PENDING'), '[]'::JSONB),
    'disputes', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', dispute.id,
      'interviewId', dispute.interview_id, 'reason', dispute.reason, 'status', dispute.status,
      'createdAt', dispute.created_at) ORDER BY dispute.created_at DESC)
      FROM candidate_disputes dispute
      WHERE dispute.status IN ('OPEN', 'REVIEWED')), '[]'::JSONB));
END $$;

REVOKE ALL ON FUNCTION authenti8_schedule_operational_retry(UUID),
  authenti8_admin_overview(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_schedule_operational_retry(UUID),
  authenti8_admin_overview(JSONB) TO service_role;

INSERT INTO schema_migrations(version) VALUES ('043_admin_recovery_controls') ON CONFLICT DO NOTHING;
COMMIT;
