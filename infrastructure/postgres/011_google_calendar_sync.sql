BEGIN;
ALTER TABLE google_integrations
  ADD COLUMN encrypted_access_token TEXT, ADD COLUMN token_expires_at TIMESTAMPTZ,
  ADD COLUMN calendar_name TEXT,
  ADD COLUMN connection_generation BIGINT NOT NULL DEFAULT 1;
ALTER TABLE interviews ADD COLUMN google_event_updated_at TIMESTAMPTZ;
ALTER TABLE calendar_sync_states
  ADD COLUMN channel_resource_id TEXT, ADD COLUMN channel_token_hash TEXT,
  ADD COLUMN channel_renewal_attempted_at TIMESTAMPTZ,
  ADD COLUMN last_full_synced_at TIMESTAMPTZ,
  ADD COLUMN last_sync_started_at TIMESTAMPTZ;
WITH ranked AS (
  SELECT id, organization_id, selected_calendar_id, row_number() OVER (
    PARTITION BY organization_id ORDER BY (status = 'ACTIVE') DESC,
    updated_at DESC, created_at DESC, id DESC) AS position
  FROM google_integrations
), discarded AS (
  SELECT old.* FROM ranked old WHERE old.position > 1 AND NOT EXISTS (SELECT 1
    FROM ranked retained WHERE retained.organization_id = old.organization_id
    AND retained.position = 1 AND retained.selected_calendar_id
      IS NOT DISTINCT FROM old.selected_calendar_id)
), stale AS (
  UPDATE interviews interview SET status = 'EXCLUDED', updated_at = now()
  FROM discarded WHERE interview.organization_id = discarded.organization_id AND
    interview.google_calendar_id = discarded.selected_calendar_id AND interview.scheduled_end > now()
    AND interview.monitoring_started_at IS NULL AND interview.status IN
      ('DETECTED', 'SYNC_FAILED', 'CANCELLED', 'EXCLUDED') RETURNING interview.id
), released AS (
  UPDATE credit_reservations reservation SET status = 'RELEASED', released_at = now(),
    release_reason = 'INELIGIBLE' FROM stale WHERE reservation.interview_id = stale.id
    AND reservation.status = 'RESERVED' RETURNING reservation.id
)
DELETE FROM google_integrations integration USING ranked
WHERE integration.id = ranked.id AND ranked.position > 1;
CREATE UNIQUE INDEX google_integrations_organization_idx ON google_integrations(organization_id);
CREATE TABLE integration_oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, state_hash TEXT NOT NULL UNIQUE,
  verifier TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE calendar_sync_jobs (
  google_integration_id UUID PRIMARY KEY REFERENCES google_integrations(id) ON DELETE CASCADE,
  connection_generation BIGINT NOT NULL, requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  lock_token UUID,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE integration_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_sync_jobs ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION authenti8_create_integration_state(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO integration_oauth_states(organization_id, user_id, state_hash, verifier, expires_at)
  SELECT organization_id, (input->>'userId')::UUID, input->>'stateHash', input->>'verifier',
    (input->>'expiresAt')::TIMESTAMPTZ FROM organization_members
  WHERE user_id = (input->>'userId')::UUID AND role IN ('OWNER', 'ADMIN')
  ORDER BY created_at LIMIT 1
  RETURNING jsonb_build_object('created', true)
$$;
CREATE OR REPLACE FUNCTION authenti8_consume_integration_state(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH consumed AS (
    UPDATE integration_oauth_states SET consumed_at = now()
    WHERE state_hash = input->>'stateHash' AND consumed_at IS NULL AND expires_at > now()
      AND user_id = (input->>'userId')::UUID
    RETURNING organization_id, user_id, verifier
  ) SELECT jsonb_build_object('organizationId', organization_id,
      'userId', user_id, 'verifier', verifier) FROM consumed
$$;
CREATE OR REPLACE FUNCTION authenti8_upsert_google_integration(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE integration UUID; previous_id UUID; previous_subject TEXT; previous_calendar TEXT;
  generation BIGINT;
  changed BOOLEAN := false;
BEGIN
  SELECT id, google_subject, selected_calendar_id
  INTO previous_id, previous_subject, previous_calendar FROM google_integrations
  WHERE organization_id = (input->>'organizationId')::UUID FOR UPDATE;
  changed := previous_id IS NOT NULL AND (previous_subject IS DISTINCT FROM input->>'subject'
    OR previous_calendar IS DISTINCT FROM input->>'calendarId');
  INSERT INTO google_integrations(organization_id, connected_user_id, google_subject,
    connected_email, encrypted_refresh_token, encrypted_access_token, token_expires_at,
    selected_calendar_id, calendar_name, status)
  VALUES ((input->>'organizationId')::UUID, (input->>'userId')::UUID, input->>'subject',
    lower(input->>'email'), input->>'refreshToken', input->>'accessToken',
    (input->>'expiresAt')::TIMESTAMPTZ, input->>'calendarId', input->>'calendarName', 'ACTIVE')
  ON CONFLICT (organization_id) DO UPDATE SET
    google_subject = EXCLUDED.google_subject,
    connected_user_id = EXCLUDED.connected_user_id,
    connected_email = EXCLUDED.connected_email,
    encrypted_refresh_token = COALESCE(NULLIF(EXCLUDED.encrypted_refresh_token, ''),
      google_integrations.encrypted_refresh_token),
    encrypted_access_token = EXCLUDED.encrypted_access_token,
    token_expires_at = EXCLUDED.token_expires_at,
    selected_calendar_id = EXCLUDED.selected_calendar_id,
    calendar_name = EXCLUDED.calendar_name, status = 'ACTIVE',
    connection_generation = google_integrations.connection_generation + 1, updated_at = now()
  RETURNING id, connection_generation INTO integration, generation;
  INSERT INTO calendar_sync_states(google_integration_id) VALUES (integration)
  ON CONFLICT (google_integration_id) DO UPDATE SET updated_at = now();
  IF changed THEN
    UPDATE calendar_sync_states SET sync_token = NULL, last_synced_at = NULL,
      last_full_synced_at = NULL,
      last_error_code = NULL, updated_at = now() WHERE google_integration_id = integration;
    DELETE FROM calendar_sync_jobs WHERE google_integration_id = integration;
    WITH stale AS (
      UPDATE interviews SET status = 'EXCLUDED', updated_at = now()
      WHERE organization_id = (input->>'organizationId')::UUID
        AND google_calendar_id = previous_calendar AND scheduled_end > now()
        AND status IN ('DETECTED', 'SYNC_FAILED', 'CANCELLED', 'EXCLUDED') RETURNING id
    ) UPDATE credit_reservations SET status = 'RELEASED', released_at = now(),
        release_reason = 'INELIGIBLE'
      WHERE interview_id IN (SELECT id FROM stale) AND status = 'RESERVED';
  END IF;
  RETURN jsonb_build_object('id', integration, 'generation', generation, 'replaced', changed);
END $$;
CREATE OR REPLACE FUNCTION authenti8_integration_credentials(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('id', integration.id, 'organizationId', integration.organization_id,
    'accessToken', integration.encrypted_access_token,
    'refreshToken', integration.encrypted_refresh_token, 'expiresAt', integration.token_expires_at,
    'calendarId', integration.selected_calendar_id, 'syncToken', sync.sync_token,
    'lastFullSyncAt', sync.last_full_synced_at,
    'channelId', sync.channel_id, 'channelResourceId', sync.channel_resource_id,
    'organizationDomain', organization.domain, 'generation', integration.connection_generation)
  FROM google_integrations integration
  JOIN organization_members member ON member.organization_id = integration.organization_id
  JOIN organizations organization ON organization.id = integration.organization_id
  LEFT JOIN calendar_sync_states sync ON sync.google_integration_id = integration.id
  WHERE member.user_id = (input->>'userId')::UUID
    AND member.role IN ('OWNER', 'ADMIN') AND integration.status = 'ACTIVE'
  ORDER BY integration.updated_at DESC LIMIT 1
$$;
CREATE OR REPLACE FUNCTION authenti8_mark_integration_error(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE google_integrations SET status = input->>'status', updated_at = now()
  WHERE id = (input->>'integrationId')::UUID
    AND connection_generation = (input->>'generation')::BIGINT AND status = 'ACTIVE'
  RETURNING jsonb_build_object('updated', true)
$$;
CREATE OR REPLACE FUNCTION authenti8_channel_credentials(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('id', integration.id, 'organizationId', integration.organization_id,
    'accessToken', integration.encrypted_access_token, 'refreshToken', integration.encrypted_refresh_token,
    'expiresAt', integration.token_expires_at, 'calendarId', integration.selected_calendar_id,
    'syncToken', sync.sync_token, 'lastFullSyncAt', sync.last_full_synced_at,
    'channelId', sync.channel_id,
    'channelResourceId', sync.channel_resource_id,
    'organizationDomain', organization.domain, 'generation', integration.connection_generation)
  FROM calendar_sync_states sync JOIN google_integrations integration
    ON integration.id = sync.google_integration_id
  JOIN organizations organization ON organization.id = integration.organization_id
  WHERE sync.channel_id = input->>'channelId'
    AND sync.channel_token_hash = input->>'channelTokenHash'
    AND integration.status = 'ACTIVE'
$$;
CREATE OR REPLACE FUNCTION authenti8_integration_credentials_by_id(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('id', integration.id, 'organizationId', integration.organization_id,
    'accessToken', integration.encrypted_access_token, 'refreshToken', integration.encrypted_refresh_token,
    'expiresAt', integration.token_expires_at, 'calendarId', integration.selected_calendar_id,
    'syncToken', sync.sync_token, 'lastFullSyncAt', sync.last_full_synced_at,
    'channelId', sync.channel_id,
    'channelResourceId', sync.channel_resource_id, 'organizationDomain', organization.domain,
    'generation', integration.connection_generation)
  FROM google_integrations integration
  JOIN organizations organization ON organization.id = integration.organization_id
  LEFT JOIN calendar_sync_states sync ON sync.google_integration_id = integration.id
  WHERE integration.id = (input->>'integrationId')::UUID AND integration.status = 'ACTIVE'
$$;
CREATE OR REPLACE FUNCTION authenti8_enqueue_calendar_sync(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE integration UUID; generation BIGINT;
BEGIN
  SELECT sync.google_integration_id, google.connection_generation INTO integration, generation
  FROM calendar_sync_states sync
  JOIN google_integrations google ON google.id = sync.google_integration_id
  WHERE sync.channel_id = input->>'channelId'
    AND sync.channel_token_hash = input->>'channelTokenHash' AND google.status = 'ACTIVE';
  IF integration IS NULL THEN RETURN jsonb_build_object('ignored', true); END IF;
  INSERT INTO calendar_sync_jobs(google_integration_id, connection_generation)
  VALUES (integration, generation) ON CONFLICT (google_integration_id) DO UPDATE SET
    requested_at = GREATEST(now(), calendar_sync_jobs.requested_at + interval '1 microsecond'),
    available_at = now(), updated_at = now();
  RETURN jsonb_build_object('queued', true);
END $$;
CREATE OR REPLACE FUNCTION authenti8_enqueue_calendar_sync_by_id(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE integration UUID := (input->>'integrationId')::UUID; generation BIGINT;
BEGIN
  SELECT connection_generation INTO generation FROM google_integrations
  WHERE id = integration AND status = 'ACTIVE';
  IF generation IS NULL THEN
    RETURN jsonb_build_object('ignored', true);
  END IF;
  INSERT INTO calendar_sync_jobs(google_integration_id, connection_generation)
  VALUES (integration, generation) ON CONFLICT (google_integration_id) DO UPDATE SET
    connection_generation = EXCLUDED.connection_generation,
    requested_at = GREATEST(now(), calendar_sync_jobs.requested_at + interval '1 microsecond'),
    available_at = now(),
    locked_at = CASE WHEN calendar_sync_jobs.connection_generation = EXCLUDED.connection_generation
      THEN calendar_sync_jobs.locked_at ELSE NULL END,
    lock_token = CASE WHEN calendar_sync_jobs.connection_generation = EXCLUDED.connection_generation
      THEN calendar_sync_jobs.lock_token ELSE NULL END, updated_at = now();
  RETURN jsonb_build_object('queued', true);
END $$;
CREATE OR REPLACE FUNCTION authenti8_enqueue_stale_calendar_syncs(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE queued INTEGER;
BEGIN
  INSERT INTO calendar_sync_jobs(google_integration_id, connection_generation)
  SELECT integration.id, integration.connection_generation FROM google_integrations integration
  JOIN calendar_sync_states sync ON sync.google_integration_id = integration.id
  WHERE integration.status = 'ACTIVE' AND integration.selected_calendar_id IS NOT NULL
    AND (sync.last_synced_at IS NULL OR sync.last_synced_at < now() - interval '30 minutes')
  ON CONFLICT (google_integration_id) DO NOTHING;
  GET DIAGNOSTICS queued = ROW_COUNT;
  RETURN jsonb_build_object('queued', queued);
END $$;
CREATE OR REPLACE FUNCTION authenti8_claim_calendar_sync_jobs(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result JSONB;
BEGIN
  WITH due AS (
    SELECT google_integration_id FROM calendar_sync_jobs
    WHERE available_at <= now() AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
    ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 5
  ), claimed AS (
    UPDATE calendar_sync_jobs job SET locked_at = now(), lock_token = gen_random_uuid(),
      attempt_count = attempt_count + 1,
      updated_at = now() FROM due WHERE job.google_integration_id = due.google_integration_id
    RETURNING job.google_integration_id, job.connection_generation, job.requested_at, job.lock_token
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('integrationId', google_integration_id,
      'generation', connection_generation, 'requestedAt', requested_at,
      'claimToken', lock_token)), '[]'::jsonb) INTO result FROM claimed;
  RETURN result;
END $$;
CREATE OR REPLACE FUNCTION authenti8_complete_calendar_sync_job(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE integration UUID := (input->>'integrationId')::UUID;
  claimed_at TIMESTAMPTZ := (input->>'requestedAt')::TIMESTAMPTZ;
  generation BIGINT := (input->>'generation')::BIGINT;
  claim_token UUID := (input->>'claimToken')::UUID; updated INTEGER;
BEGIN
  IF (input->>'success')::BOOLEAN THEN
    DELETE FROM calendar_sync_jobs WHERE google_integration_id = integration
      AND connection_generation = generation AND lock_token = claim_token
      AND requested_at <= claimed_at;
    UPDATE calendar_sync_jobs SET locked_at = NULL, attempt_count = 0,
      lock_token = NULL, available_at = now(), last_error_code = NULL, updated_at = now()
    WHERE google_integration_id = integration AND connection_generation = generation
      AND lock_token = claim_token;
  ELSE
    IF EXISTS (SELECT 1 FROM calendar_sync_jobs WHERE google_integration_id = integration
      AND connection_generation = generation AND lock_token = claim_token
      AND requested_at > claimed_at) THEN
      UPDATE calendar_sync_jobs SET locked_at = NULL, lock_token = NULL, attempt_count = 0,
        available_at = now(), last_error_code = NULL, updated_at = now()
      WHERE google_integration_id = integration AND connection_generation = generation
        AND lock_token = claim_token;
      RETURN jsonb_build_object('completed', true, 'superseded', true);
    END IF;
    UPDATE calendar_sync_jobs SET locked_at = NULL, lock_token = NULL,
      available_at = now() + LEAST(attempt_count, 10) * interval '1 minute',
      last_error_code = input->>'errorCode', updated_at = now()
    WHERE google_integration_id = integration AND connection_generation = generation
      AND lock_token = claim_token;
    GET DIAGNOSTICS updated = ROW_COUNT;
    IF updated = 1 THEN
      UPDATE calendar_sync_states SET last_error_code = input->>'errorCode', updated_at = now()
      WHERE google_integration_id = integration;
    END IF;
  END IF;
  RETURN jsonb_build_object('completed', true);
END $$;
CREATE OR REPLACE FUNCTION authenti8_due_calendar_channels(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result JSONB;
BEGIN
  WITH due AS (
    SELECT sync.google_integration_id FROM calendar_sync_states sync
    JOIN google_integrations integration ON integration.id = sync.google_integration_id
    WHERE integration.status = 'ACTIVE' AND integration.selected_calendar_id IS NOT NULL
      AND (sync.channel_expires_at IS NULL OR sync.channel_expires_at < now() + interval '2 days')
      AND (sync.channel_renewal_attempted_at IS NULL
        OR sync.channel_renewal_attempted_at < now() - interval '15 minutes')
    ORDER BY sync.channel_expires_at NULLS FIRST
    FOR UPDATE OF sync SKIP LOCKED LIMIT 50
  ), claimed AS (
    UPDATE calendar_sync_states sync SET channel_renewal_attempted_at = now()
    FROM due WHERE sync.google_integration_id = due.google_integration_id
    RETURNING sync.*
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('id', integration.id,
      'organizationId', integration.organization_id,
      'accessToken', integration.encrypted_access_token,
      'refreshToken', integration.encrypted_refresh_token,
      'expiresAt', integration.token_expires_at,
      'calendarId', integration.selected_calendar_id,
      'syncToken', sync.sync_token, 'lastFullSyncAt', sync.last_full_synced_at,
      'channelId', sync.channel_id,
      'channelResourceId', sync.channel_resource_id,
      'organizationDomain', organization.domain,
      'generation', integration.connection_generation)), '[]'::jsonb) INTO result
    FROM claimed sync
    JOIN google_integrations integration ON integration.id = sync.google_integration_id
    JOIN organizations organization ON organization.id = integration.organization_id;
  RETURN result;
END;
$$;
CREATE OR REPLACE FUNCTION authenti8_integration_summary(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT jsonb_build_object('provider', 'GOOGLE_MEET',
    'status', integration.status, 'connectedEmail', integration.connected_email,
    'calendarName', integration.calendar_name, 'lastSyncedAt', sync.last_synced_at,
    'lastErrorCode', sync.last_error_code)
  FROM google_integrations integration
  JOIN organization_members member ON member.organization_id = integration.organization_id
  LEFT JOIN calendar_sync_states sync ON sync.google_integration_id = integration.id
  WHERE member.user_id = (input->>'userId')::UUID ORDER BY integration.updated_at DESC LIMIT 1),
  jsonb_build_object('provider', 'GOOGLE_MEET', 'status', 'NOT_CONNECTED',
    'connectedEmail', NULL, 'calendarName', NULL, 'lastSyncedAt', NULL, 'lastErrorCode', NULL))
$$;
CREATE OR REPLACE FUNCTION authenti8_organization_domain(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('domain', domain) FROM organizations
  WHERE id = (input->>'organizationId')::UUID
$$;
CREATE OR REPLACE FUNCTION authenti8_store_google_token(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE google_integrations SET encrypted_access_token = input->>'accessToken',
    encrypted_refresh_token = COALESCE(NULLIF(input->>'refreshToken', ''), encrypted_refresh_token),
    token_expires_at = (input->>'expiresAt')::TIMESTAMPTZ, updated_at = now()
  WHERE id = (input->>'integrationId')::UUID
    AND connection_generation = (input->>'generation')::BIGINT AND status = 'ACTIVE'
  RETURNING jsonb_build_object('updated', true)
$$;
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
      UPDATE interviews existing SET status = 'EXCLUDED', updated_at = now()
      WHERE existing.organization_id = integration.organization_id
        AND existing.google_calendar_id = integration.selected_calendar_id
        AND existing.status IN ('DETECTED', 'SYNC_FAILED', 'CANCELLED', 'EXCLUDED')
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
        THEN 'CANCELLED' ELSE 'EXCLUDED' END,
        google_event_updated_at = COALESCE(
          NULLIF(event->>'updatedAt', '')::TIMESTAMPTZ, google_event_updated_at), updated_at = now()
      WHERE organization_id = integration.organization_id
        AND google_calendar_id = integration.selected_calendar_id
        AND google_event_id = event->>'eventId'
        AND status IN ('DETECTED', 'SYNC_FAILED', 'CANCELLED', 'EXCLUDED')
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
      status = CASE WHEN interviews.status IN ('CANCELLED', 'EXCLUDED')
        THEN 'DETECTED' ELSE interviews.status END,
      updated_at = now()
    WHERE ((EXCLUDED.google_event_updated_at IS NOT NULL AND (interviews.google_event_updated_at
        IS NULL OR EXCLUDED.google_event_updated_at >= interviews.google_event_updated_at))
      OR (EXCLUDED.google_event_updated_at IS NULL AND interviews.google_event_updated_at IS NULL))
      AND interviews.monitoring_started_at IS NULL
      AND interviews.status NOT IN (
        'MONITORING_ACTIVE', 'MEETING_COMPLETED', 'REPORT_PROCESSING', 'REPORT_READY'
      )
    RETURNING id INTO interview;
    IF interview IS NULL THEN CONTINUE; END IF;
    DELETE FROM interview_participants WHERE interview_id = interview;
    FOR participant IN SELECT * FROM jsonb_array_elements(event->'participants') LOOP
      INSERT INTO interview_participants(interview_id, email, display_name,
        participant_type, is_external) VALUES (interview, participant->>'email',
        participant->>'name', participant->>'type', (participant->>'external')::BOOLEAN);
    END LOOP; total := total + 1;
  END LOOP;
  UPDATE calendar_sync_states SET sync_token = input->>'syncToken', last_synced_at = now(),
    last_sync_started_at = sync_started,
    last_full_synced_at = CASE WHEN COALESCE((input->>'fullSync')::BOOLEAN, false)
      THEN now() ELSE last_full_synced_at END,
    last_error_code = NULL, updated_at = now() WHERE google_integration_id = integration.id;
  RETURN jsonb_build_object('synced', total);
END $$;
CREATE OR REPLACE FUNCTION authenti8_store_calendar_channel(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE calendar_sync_states SET channel_id = input->>'channelId',
    channel_resource_id = input->>'resourceId', channel_token_hash = input->>'channelTokenHash',
    channel_expires_at = (input->>'expiresAt')::TIMESTAMPTZ,
    channel_renewal_attempted_at = NULL, last_error_code = NULL, updated_at = now()
  WHERE google_integration_id = (input->>'integrationId')::UUID
    AND EXISTS (SELECT 1 FROM google_integrations integration
      WHERE integration.id = google_integration_id AND integration.status = 'ACTIVE'
        AND integration.connection_generation = (input->>'generation')::BIGINT)
  RETURNING jsonb_build_object('updated', true)
$$;
CREATE OR REPLACE FUNCTION authenti8_disconnect_google(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE integration_id UUID; org UUID; calendar_id TEXT;
BEGIN
  SELECT integration.id, integration.organization_id, integration.selected_calendar_id
  INTO integration_id, org, calendar_id FROM google_integrations integration
  JOIN organization_members member ON member.organization_id = integration.organization_id
  WHERE member.user_id = (input->>'userId')::UUID AND member.role IN ('OWNER', 'ADMIN')
  ORDER BY integration.updated_at DESC LIMIT 1 FOR UPDATE OF integration;
  IF integration_id IS NULL THEN RETURN jsonb_build_object('disconnected', false); END IF;
  UPDATE google_integrations SET status = 'NOT_CONNECTED', encrypted_access_token = NULL,
    encrypted_refresh_token = '', token_expires_at = NULL,
    connection_generation = connection_generation + 1, updated_at = now()
  WHERE id = integration_id;
  DELETE FROM calendar_sync_jobs WHERE google_integration_id = integration_id;
  UPDATE calendar_sync_states SET sync_token = NULL, last_full_synced_at = NULL, channel_id = NULL,
    channel_resource_id = NULL, channel_token_hash = NULL, channel_expires_at = NULL,
    channel_renewal_attempted_at = NULL, updated_at = now()
  WHERE google_integration_id = integration_id;
  WITH stale AS (
    UPDATE interviews SET status = 'EXCLUDED', updated_at = now()
    WHERE organization_id = org AND google_calendar_id = calendar_id AND scheduled_end > now()
      AND status IN ('DETECTED', 'SYNC_FAILED', 'CANCELLED', 'EXCLUDED') RETURNING id
  ) UPDATE credit_reservations SET status = 'RELEASED', released_at = now(),
      release_reason = 'INELIGIBLE'
    WHERE interview_id IN (SELECT id FROM stale) AND status = 'RESERVED';
  RETURN jsonb_build_object('disconnected', true);
END $$;
DO $$
DECLARE function_name TEXT;
BEGIN
  FOREACH function_name IN ARRAY ARRAY[
    'authenti8_create_integration_state', 'authenti8_consume_integration_state',
    'authenti8_upsert_google_integration', 'authenti8_integration_credentials',
    'authenti8_integration_summary', 'authenti8_organization_domain',
    'authenti8_store_google_token', 'authenti8_mark_integration_error',
    'authenti8_channel_credentials', 'authenti8_due_calendar_channels',
    'authenti8_integration_credentials_by_id', 'authenti8_enqueue_calendar_sync',
    'authenti8_enqueue_calendar_sync_by_id',
    'authenti8_enqueue_stale_calendar_syncs', 'authenti8_claim_calendar_sync_jobs',
    'authenti8_complete_calendar_sync_job',
    'authenti8_apply_calendar_sync', 'authenti8_store_calendar_channel',
    'authenti8_disconnect_google'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I(JSONB) FROM PUBLIC, anon, authenticated', function_name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I(JSONB) TO service_role', function_name);
  END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES ('011_google_calendar_sync');
COMMIT;
