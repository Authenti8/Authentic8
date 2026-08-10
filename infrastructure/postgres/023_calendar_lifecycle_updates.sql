BEGIN;

CREATE OR REPLACE FUNCTION authenti8_calendar_lifecycle_cleanup() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.status = 'VERIFICATION_SCHEDULED'
    AND (OLD.scheduled_start IS DISTINCT FROM NEW.scheduled_start
      OR OLD.scheduled_end IS DISTINCT FROM NEW.scheduled_end) THEN
    UPDATE verification_delivery_jobs SET
      scheduled_for = NEW.scheduled_start - interval '1 minute',
      available_at = NEW.scheduled_start - interval '1 minute', status = 'PENDING', attempts = 0,
      lease_until = NULL, claim_token = NULL, last_error = NULL, completed_at = NULL,
      updated_at = now() WHERE interview_id = NEW.id AND status <> 'COMPLETED';
    NEW.verification_delivery_status := 'SCHEDULED';
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('DETECTED', 'CANCELLED', 'EXCLUDED') THEN
    UPDATE candidate_verification_tokens SET consumed_at = COALESCE(consumed_at, now())
      WHERE interview_id = NEW.id AND consumed_at IS NULL;
    DELETE FROM auth_email_outbox WHERE interview_id = NEW.id
      AND kind = 'candidate_verification' AND status IN ('PENDING', 'PROCESSING');
    DELETE FROM verification_delivery_jobs WHERE interview_id = NEW.id;
    UPDATE verification_sessions SET status = 'CANCELLED',
      monitoring_ended_at = COALESCE(monitoring_ended_at, now())
      WHERE interview_id = NEW.id AND monitoring_started_at IS NULL;
    NEW.verification_delivery_status := 'NOT_SCHEDULED';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS authenti8_calendar_lifecycle_cleanup ON interviews;
CREATE TRIGGER authenti8_calendar_lifecycle_cleanup
  BEFORE UPDATE OF status, scheduled_start, scheduled_end ON interviews
  FOR EACH ROW EXECUTE FUNCTION authenti8_calendar_lifecycle_cleanup();
REVOKE ALL ON FUNCTION authenti8_calendar_lifecycle_cleanup()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION authenti8_cancel_consented_replaced_calendar() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.status = 'ACTIVE' AND (NEW.status <> 'ACTIVE'
    OR OLD.selected_calendar_id IS DISTINCT FROM NEW.selected_calendar_id
    OR OLD.google_subject IS DISTINCT FROM NEW.google_subject) THEN
    WITH cancelled AS (
      UPDATE interviews SET status = 'CANCELLED', updated_at = now()
      WHERE organization_id = OLD.organization_id
        AND google_calendar_id = OLD.selected_calendar_id
        AND status = 'DEVICE_CONNECTING' AND monitoring_started_at IS NULL
      RETURNING id
    ) UPDATE credit_reservations reservation SET status = 'RELEASED', released_at = now(),
        release_reason = 'INELIGIBLE' FROM cancelled
      WHERE reservation.interview_id = cancelled.id AND reservation.status = 'RESERVED';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS authenti8_google_consented_calendar_cleanup ON google_integrations;
CREATE TRIGGER authenti8_google_consented_calendar_cleanup
AFTER UPDATE OF status, selected_calendar_id, google_subject ON google_integrations
FOR EACH ROW EXECUTE FUNCTION authenti8_cancel_consented_replaced_calendar();
REVOKE ALL ON FUNCTION authenti8_cancel_consented_replaced_calendar()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION authenti8_apply_calendar_sync(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE event JSONB; participant JSONB; interview UUID; integration google_integrations;
  total INTEGER := 0; sync_started TIMESTAMPTZ := COALESCE(
    NULLIF(input->>'syncStartedAt', '')::TIMESTAMPTZ, now());
BEGIN
  SELECT * INTO integration FROM google_integrations
  WHERE id = (input->>'integrationId')::UUID AND status = 'ACTIVE'
    AND connection_generation = (input->>'generation')::BIGINT
    AND selected_calendar_id = input->>'calendarId' FOR UPDATE;
  IF integration.id IS NULL THEN RETURN jsonb_build_object('ignored', true); END IF;
  IF EXISTS (SELECT 1 FROM calendar_sync_states state
    WHERE state.google_integration_id = integration.id
      AND state.last_sync_started_at > sync_started) THEN
    RETURN jsonb_build_object('ignored', true, 'reason', 'STALE_SYNC');
  END IF;
  IF COALESCE((input->>'fullSync')::BOOLEAN, false) THEN
    WITH stale AS (
      UPDATE interviews existing SET status = CASE WHEN existing.status = 'DEVICE_CONNECTING'
        THEN 'CANCELLED' ELSE 'EXCLUDED' END, updated_at = now()
      WHERE existing.organization_id = integration.organization_id
        AND existing.google_calendar_id = integration.selected_calendar_id
        AND existing.status IN ('DETECTED', 'PROTECTED', 'VERIFICATION_SCHEDULED',
          'WAITING_FOR_CANDIDATE', 'CONSENT_PENDING', 'DEVICE_CONNECTING', 'SYNC_FAILED', 'EXCLUDED',
          'NO_CREDITS', 'SUBSCRIPTION_INACTIVE', 'UNABLE_TO_VERIFY')
        AND NULLIF(input->>'scanWindowStart', '') IS NOT NULL
        AND NULLIF(input->>'scanWindowEnd', '') IS NOT NULL
        AND existing.scheduled_end > (input->>'scanWindowStart')::TIMESTAMPTZ
        AND existing.scheduled_start < (input->>'scanWindowEnd')::TIMESTAMPTZ
        AND (existing.google_event_updated_at IS NULL
          OR existing.google_event_updated_at <= sync_started)
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(input->'events') incoming
          WHERE incoming->>'eventId' = existing.google_event_id)
      RETURNING existing.id
    ) UPDATE credit_reservations reservation SET status = 'RELEASED', released_at = now(),
        release_reason = 'INELIGIBLE'
      FROM stale WHERE reservation.interview_id = stale.id AND reservation.status = 'RESERVED';
  END IF;
  FOR event IN SELECT * FROM jsonb_array_elements(input->'events') LOOP
    interview := NULL;
    IF event->>'cancelled' = 'true' OR event->>'excluded' = 'true' THEN
      UPDATE interviews SET status = CASE WHEN event->>'cancelled' = 'true'
          OR status = 'DEVICE_CONNECTING' THEN 'CANCELLED' ELSE 'EXCLUDED' END,
        google_event_updated_at = COALESCE(
          NULLIF(event->>'updatedAt', '')::TIMESTAMPTZ, google_event_updated_at), updated_at = now()
      WHERE organization_id = integration.organization_id
        AND google_calendar_id = integration.selected_calendar_id
        AND google_event_id = event->>'eventId'
        AND status IN ('DETECTED', 'PROTECTED', 'VERIFICATION_SCHEDULED',
          'WAITING_FOR_CANDIDATE', 'CONSENT_PENDING', 'DEVICE_CONNECTING', 'SYNC_FAILED',
          'CANCELLED', 'EXCLUDED',
          'NO_CREDITS', 'SUBSCRIPTION_INACTIVE', 'UNABLE_TO_VERIFY')
        AND (google_event_updated_at IS NULL OR (
          NULLIF(event->>'updatedAt', '') IS NOT NULL
          AND (event->>'updatedAt')::TIMESTAMPTZ >= google_event_updated_at))
      RETURNING id INTO interview;
      UPDATE credit_reservations SET status = 'RELEASED', released_at = now(),
        release_reason = 'INELIGIBLE'
      WHERE interview_id = interview AND status = 'RESERVED';
      CONTINUE;
    END IF;
    INSERT INTO interviews(organization_id, google_event_id, google_calendar_id,
      google_meet_code, google_meet_url, candidate_email, candidate_name,
      organizer_email, title, classification_reason, scheduled_start, scheduled_end,
      google_event_updated_at)
    VALUES (integration.organization_id, event->>'eventId', integration.selected_calendar_id,
      event->>'meetCode', event->>'meetUrl', event->>'candidateEmail', event->>'candidateName',
      event->>'organizerEmail', event->>'title', event->>'reason',
      (event->>'start')::TIMESTAMPTZ, (event->>'end')::TIMESTAMPTZ,
      (event->>'updatedAt')::TIMESTAMPTZ)
    ON CONFLICT (organization_id, google_calendar_id, google_event_id) DO UPDATE SET
      google_meet_code = EXCLUDED.google_meet_code, google_meet_url = EXCLUDED.google_meet_url,
      candidate_email = EXCLUDED.candidate_email, candidate_name = EXCLUDED.candidate_name,
      organizer_email = EXCLUDED.organizer_email, title = EXCLUDED.title,
      classification_reason = EXCLUDED.classification_reason,
      scheduled_start = EXCLUDED.scheduled_start, scheduled_end = EXCLUDED.scheduled_end,
      google_event_updated_at = EXCLUDED.google_event_updated_at,
      status = CASE
        WHEN interviews.status IN ('CANCELLED', 'EXCLUDED') THEN 'DETECTED'
        WHEN interviews.status IN ('WAITING_FOR_CANDIDATE', 'CONSENT_PENDING',
          'DEVICE_CONNECTING', 'UNABLE_TO_VERIFY')
          AND (interviews.scheduled_start IS DISTINCT FROM EXCLUDED.scheduled_start
            OR interviews.scheduled_end IS DISTINCT FROM EXCLUDED.scheduled_end
            OR interviews.candidate_email IS DISTINCT FROM EXCLUDED.candidate_email) THEN 'DETECTED'
        ELSE interviews.status END, updated_at = now()
    WHERE ((EXCLUDED.google_event_updated_at IS NOT NULL AND (interviews.google_event_updated_at
        IS NULL OR EXCLUDED.google_event_updated_at >= interviews.google_event_updated_at))
      OR (EXCLUDED.google_event_updated_at IS NULL AND interviews.google_event_updated_at IS NULL))
      AND interviews.monitoring_started_at IS NULL
      AND interviews.status NOT IN ('MONITORING_ACTIVE', 'MEETING_COMPLETED',
        'REPORT_PROCESSING', 'REPORT_READY', 'CONSENT_DECLINED')
    RETURNING id INTO interview;
    IF interview IS NULL THEN CONTINUE; END IF;
    DELETE FROM interview_participants WHERE interview_id = interview;
    FOR participant IN SELECT * FROM jsonb_array_elements(event->'participants') LOOP
      INSERT INTO interview_participants(interview_id, email, display_name,
        participant_type, is_external) VALUES (interview, participant->>'email',
        participant->>'name', participant->>'type', (participant->>'external')::BOOLEAN);
    END LOOP;
    total := total + 1;
  END LOOP;
  UPDATE calendar_sync_states SET sync_token = input->>'syncToken', last_synced_at = now(),
    last_sync_started_at = sync_started,
    last_full_synced_at = CASE WHEN COALESCE((input->>'fullSync')::BOOLEAN, false)
      THEN now() ELSE last_full_synced_at END,
    last_error_code = NULL, updated_at = now() WHERE google_integration_id = integration.id;
  RETURN jsonb_build_object('synced', total);
END $$;

REVOKE ALL ON FUNCTION authenti8_apply_calendar_sync(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_apply_calendar_sync(JSONB) TO service_role;

INSERT INTO schema_migrations(version) VALUES ('023_calendar_lifecycle_updates')
ON CONFLICT (version) DO NOTHING;
COMMIT;
