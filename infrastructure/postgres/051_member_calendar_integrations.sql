BEGIN;

DROP INDEX IF EXISTS google_integrations_organization_idx;
CREATE UNIQUE INDEX google_integrations_member_idx
  ON google_integrations(organization_id, connected_user_id);

ALTER TABLE interviews
  ADD COLUMN source_google_integration_id UUID REFERENCES google_integrations(id) ON DELETE SET NULL,
  ADD COLUMN calendar_event_key TEXT;
UPDATE interviews interview SET source_google_integration_id = (
  SELECT integration.id FROM google_integrations integration
  WHERE integration.organization_id = interview.organization_id
    AND integration.selected_calendar_id = interview.google_calendar_id
  ORDER BY (integration.status = 'ACTIVE') DESC, integration.updated_at DESC LIMIT 1)
WHERE source_google_integration_id IS NULL;
UPDATE interviews SET calendar_event_key='google:'||google_event_id||':'||google_meet_code
WHERE source_google_integration_id IS NOT NULL AND calendar_event_key IS NULL;
CREATE INDEX interviews_source_integration_idx
  ON interviews(source_google_integration_id, scheduled_start DESC);
CREATE UNIQUE INDEX interviews_org_calendar_event_key_idx
  ON interviews(organization_id,calendar_event_key) WHERE calendar_event_key IS NOT NULL;

CREATE TABLE calendar_interview_sources(
  google_integration_id UUID NOT NULL REFERENCES google_integrations(id) ON DELETE CASCADE,
  provider_event_id TEXT NOT NULL,
  interview_id UUID NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(google_integration_id,provider_event_id)
);
CREATE INDEX calendar_interview_sources_interview_idx
  ON calendar_interview_sources(interview_id);
INSERT INTO calendar_interview_sources(google_integration_id,provider_event_id,interview_id)
SELECT source_google_integration_id,google_event_id,id FROM interviews
WHERE source_google_integration_id IS NOT NULL ON CONFLICT DO NOTHING;
ALTER TABLE calendar_interview_sources ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION authenti8_create_integration_state(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO integration_oauth_states(organization_id,user_id,state_hash,verifier,expires_at)
  SELECT organization_id,(input->>'userId')::UUID,input->>'stateHash',input->>'verifier',
    (input->>'expiresAt')::TIMESTAMPTZ FROM organization_members
  WHERE user_id=(input->>'userId')::UUID AND business_role IN ('OWNER','MANAGER','HR')
    AND status='ACTIVE' ORDER BY created_at LIMIT 1
  RETURNING jsonb_build_object('created',true)
$$;

CREATE OR REPLACE FUNCTION authenti8_upsert_google_integration(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE integration UUID; previous_id UUID; previous_subject TEXT; previous_calendar TEXT;
  generation BIGINT; changed BOOLEAN := false; actor UUID := (input->>'userId')::UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organization_members WHERE
      organization_id=(input->>'organizationId')::UUID AND user_id=actor
      AND business_role IN ('OWNER','MANAGER','HR') AND status='ACTIVE') THEN
    RETURN NULL;
  END IF;
  SELECT id,google_subject,selected_calendar_id INTO previous_id,previous_subject,previous_calendar
  FROM google_integrations WHERE organization_id=(input->>'organizationId')::UUID
    AND connected_user_id=actor FOR UPDATE;
  changed := previous_id IS NOT NULL AND (previous_subject IS DISTINCT FROM input->>'subject'
    OR previous_calendar IS DISTINCT FROM input->>'calendarId');
  INSERT INTO google_integrations(organization_id,connected_user_id,google_subject,
    connected_email,encrypted_refresh_token,encrypted_access_token,token_expires_at,
    selected_calendar_id,calendar_name,status)
  VALUES((input->>'organizationId')::UUID,actor,input->>'subject',lower(input->>'email'),
    input->>'refreshToken',input->>'accessToken',(input->>'expiresAt')::TIMESTAMPTZ,
    input->>'calendarId',input->>'calendarName','ACTIVE')
  ON CONFLICT (organization_id,connected_user_id) DO UPDATE SET
    google_subject=EXCLUDED.google_subject,connected_email=EXCLUDED.connected_email,
    encrypted_refresh_token=COALESCE(NULLIF(EXCLUDED.encrypted_refresh_token,''),
      google_integrations.encrypted_refresh_token),
    encrypted_access_token=EXCLUDED.encrypted_access_token,
    token_expires_at=EXCLUDED.token_expires_at,selected_calendar_id=EXCLUDED.selected_calendar_id,
    calendar_name=EXCLUDED.calendar_name,status='ACTIVE',
    connection_generation=google_integrations.connection_generation+1,updated_at=now()
  RETURNING id,connection_generation INTO integration,generation;
  INSERT INTO calendar_sync_states(google_integration_id) VALUES(integration)
    ON CONFLICT(google_integration_id) DO UPDATE SET updated_at=now();
  IF changed THEN
    UPDATE calendar_sync_states SET sync_token=NULL,last_synced_at=NULL,last_full_synced_at=NULL,
      last_error_code=NULL,updated_at=now() WHERE google_integration_id=integration;
    DELETE FROM calendar_sync_jobs WHERE google_integration_id=integration;
  END IF;
  RETURN jsonb_build_object('id',integration,'generation',generation,'replaced',changed);
END $$;

CREATE OR REPLACE FUNCTION authenti8_integration_credentials(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('id',integration.id,'organizationId',integration.organization_id,
    'accessToken',integration.encrypted_access_token,'refreshToken',integration.encrypted_refresh_token,
    'expiresAt',integration.token_expires_at,'calendarId',integration.selected_calendar_id,
    'syncToken',sync.sync_token,'lastFullSyncAt',sync.last_full_synced_at,
    'channelId',sync.channel_id,'channelResourceId',sync.channel_resource_id,
    'organizationDomain',organization.domain,'generation',integration.connection_generation)
  FROM google_integrations integration JOIN organization_members member
    ON member.organization_id=integration.organization_id
      AND member.user_id=integration.connected_user_id
  JOIN organizations organization ON organization.id=integration.organization_id
  LEFT JOIN calendar_sync_states sync ON sync.google_integration_id=integration.id
  WHERE integration.connected_user_id=(input->>'userId')::UUID AND member.status='ACTIVE'
    AND member.business_role IN ('OWNER','MANAGER','HR') AND integration.status='ACTIVE'
  ORDER BY integration.updated_at DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION authenti8_integration_summary(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT jsonb_build_object('provider','GOOGLE_MEET','status',integration.status,
    'connectedEmail',integration.connected_email,'calendarName',integration.calendar_name,
    'lastSyncedAt',sync.last_synced_at,'lastErrorCode',sync.last_error_code)
  FROM google_integrations integration JOIN organization_members member
    ON member.organization_id=integration.organization_id
      AND member.user_id=integration.connected_user_id
  LEFT JOIN calendar_sync_states sync ON sync.google_integration_id=integration.id
  WHERE integration.connected_user_id=(input->>'userId')::UUID AND member.status='ACTIVE'
  ORDER BY integration.updated_at DESC LIMIT 1),jsonb_build_object('provider','GOOGLE_MEET',
    'status','NOT_CONNECTED','connectedEmail',NULL,'calendarName',NULL,
    'lastSyncedAt',NULL,'lastErrorCode',NULL))
$$;

CREATE OR REPLACE FUNCTION authenti8_assign_interview_owner() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.calendar_event_key IS NULL AND NEW.google_event_id IS NOT NULL
      AND NEW.google_meet_code IS NOT NULL THEN
    NEW.calendar_event_key := 'google:'||NEW.google_event_id||':'||NEW.google_meet_code;
  END IF;
  IF NEW.responsible_member_user_id IS NULL THEN
    SELECT member.user_id INTO NEW.responsible_member_user_id FROM organization_members member
    JOIN users account ON account.id=member.user_id WHERE member.organization_id=NEW.organization_id
      AND member.status='ACTIVE' AND account.normalized_email=lower(NEW.organizer_email)
    ORDER BY member.created_at LIMIT 1;
  END IF;
  IF NEW.responsible_member_user_id IS NULL AND NEW.source_google_integration_id IS NOT NULL THEN
    SELECT connected_user_id INTO NEW.responsible_member_user_id FROM google_integrations
    WHERE id=NEW.source_google_integration_id AND organization_id=NEW.organization_id;
  END IF;
  IF NEW.responsible_member_user_id IS NULL THEN
    SELECT user_id INTO NEW.responsible_member_user_id FROM organization_members
    WHERE organization_id=NEW.organization_id AND business_role='OWNER' AND status='ACTIVE'
    ORDER BY created_at LIMIT 1;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS authenti8_interview_owner_before_write ON interviews;
CREATE TRIGGER authenti8_interview_owner_before_write BEFORE INSERT OR UPDATE OF
  organizer_email,source_google_integration_id ON interviews FOR EACH ROW
  EXECUTE FUNCTION authenti8_assign_interview_owner();

CREATE OR REPLACE FUNCTION authenti8_cancel_consented_replaced_calendar() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF OLD.status='ACTIVE' AND (NEW.status<>'ACTIVE'
    OR OLD.selected_calendar_id IS DISTINCT FROM NEW.selected_calendar_id
    OR OLD.google_subject IS DISTINCT FROM NEW.google_subject) THEN
    WITH removed AS (DELETE FROM calendar_interview_sources
      WHERE google_integration_id=OLD.id RETURNING interview_id),
    affected AS (SELECT interview_id AS id FROM removed UNION SELECT id FROM interviews
      WHERE source_google_integration_id IS NULL AND organization_id=OLD.organization_id
        AND google_calendar_id=OLD.selected_calendar_id),
    cancelled AS (UPDATE interviews interview SET status=CASE
        WHEN interview.status='DEVICE_CONNECTING' THEN 'CANCELLED' ELSE 'EXCLUDED' END,
        updated_at=now() FROM affected WHERE interview.id=affected.id
        AND NOT EXISTS(SELECT 1 FROM calendar_interview_sources source
          WHERE source.interview_id=interview.id AND source.google_integration_id<>OLD.id)
        AND interview.status IN ('DETECTED','PROTECTED','VERIFICATION_SCHEDULED',
          'WAITING_FOR_CANDIDATE','CONSENT_PENDING','DEVICE_CONNECTING','SYNC_FAILED','EXCLUDED',
          'NO_CREDITS','SUBSCRIPTION_INACTIVE','UNABLE_TO_VERIFY')
        AND interview.monitoring_started_at IS NULL RETURNING interview.id)
    UPDATE credit_reservations reservation SET status='RELEASED',released_at=now(),
      release_reason='INELIGIBLE' FROM cancelled WHERE reservation.interview_id=cancelled.id
      AND reservation.status='RESERVED';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION authenti8_disconnect_google(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE integration_id UUID; org UUID; calendar_id TEXT;
BEGIN
  SELECT integration.id,integration.organization_id,integration.selected_calendar_id
    INTO integration_id,org,calendar_id
  FROM google_integrations integration JOIN organization_members member
    ON member.organization_id=integration.organization_id
      AND member.user_id=integration.connected_user_id
  WHERE integration.connected_user_id=(input->>'userId')::UUID AND member.status='ACTIVE'
    AND member.business_role IN ('OWNER','MANAGER','HR') ORDER BY integration.updated_at DESC
    LIMIT 1 FOR UPDATE OF integration;
  IF integration_id IS NULL THEN RETURN jsonb_build_object('disconnected',false); END IF;
  UPDATE google_integrations SET status='NOT_CONNECTED',encrypted_access_token=NULL,
    encrypted_refresh_token='',token_expires_at=NULL,connection_generation=connection_generation+1,
    updated_at=now() WHERE id=integration_id;
  DELETE FROM calendar_sync_jobs WHERE google_integration_id=integration_id;
  UPDATE calendar_sync_states SET sync_token=NULL,last_full_synced_at=NULL,channel_id=NULL,
    channel_resource_id=NULL,channel_token_hash=NULL,channel_expires_at=NULL,
    channel_renewal_attempted_at=NULL,updated_at=now() WHERE google_integration_id=integration_id;
  RETURN jsonb_build_object('disconnected',true);
END $$;

CREATE OR REPLACE FUNCTION authenti8_disable_member_calendar() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF OLD.status='ACTIVE' AND NEW.status<>'ACTIVE' THEN
    UPDATE google_integrations SET status='NOT_CONNECTED',encrypted_access_token=NULL,
      encrypted_refresh_token='',token_expires_at=NULL,
      connection_generation=connection_generation+1,updated_at=now()
    WHERE organization_id=NEW.organization_id AND connected_user_id=NEW.user_id;
    DELETE FROM calendar_sync_jobs job USING google_integrations integration
    WHERE job.google_integration_id=integration.id AND integration.organization_id=NEW.organization_id
      AND integration.connected_user_id=NEW.user_id;
    UPDATE calendar_sync_states state SET sync_token=NULL,last_full_synced_at=NULL,channel_id=NULL,
      channel_resource_id=NULL,channel_token_hash=NULL,channel_expires_at=NULL,
      channel_renewal_attempted_at=NULL,updated_at=now() FROM google_integrations integration
    WHERE state.google_integration_id=integration.id AND integration.organization_id=NEW.organization_id
      AND integration.connected_user_id=NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authenti8_member_calendar_after_status AFTER UPDATE OF status ON organization_members
  FOR EACH ROW EXECUTE FUNCTION authenti8_disable_member_calendar();

CREATE OR REPLACE FUNCTION authenti8_apply_calendar_sync(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE event JSONB; participant JSONB; interview UUID; legacy_interview UUID;
  canonical_interview UUID; survivor UUID; duplicate UUID; legacy_rank INTEGER;
  canonical_rank INTEGER; integration google_integrations;
  total INTEGER:=0; sync_started TIMESTAMPTZ:=COALESCE(
    NULLIF(input->>'syncStartedAt','')::TIMESTAMPTZ,now());
BEGIN
  SELECT * INTO integration FROM google_integrations WHERE id=(input->>'integrationId')::UUID
    AND status='ACTIVE' AND connection_generation=(input->>'generation')::BIGINT
    AND selected_calendar_id=input->>'calendarId' FOR UPDATE;
  IF integration.id IS NULL THEN RETURN jsonb_build_object('ignored',true); END IF;
  IF EXISTS(SELECT 1 FROM calendar_sync_states state WHERE
      state.google_integration_id=integration.id AND state.last_sync_started_at>sync_started) THEN
    RETURN jsonb_build_object('ignored',true,'reason','STALE_SYNC'); END IF;
  IF COALESCE((input->>'fullSync')::BOOLEAN,false) THEN
    WITH stale AS (UPDATE interviews existing SET status=CASE
        WHEN existing.status='DEVICE_CONNECTING' THEN 'CANCELLED' ELSE 'EXCLUDED' END,
        updated_at=now() WHERE (EXISTS(SELECT 1 FROM calendar_interview_sources source
          WHERE source.interview_id=existing.id AND source.google_integration_id=integration.id
            AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(input->'events') incoming
              WHERE incoming->>'eventId'=source.provider_event_id)) OR
          (existing.source_google_integration_id IS NULL
            AND existing.organization_id=integration.organization_id
            AND existing.google_calendar_id=integration.selected_calendar_id
            AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(input->'events') incoming
              WHERE incoming->>'eventId'=existing.google_event_id)))
        AND NOT EXISTS(SELECT 1 FROM calendar_interview_sources source
          WHERE source.interview_id=existing.id AND (source.google_integration_id<>integration.id
            OR EXISTS(SELECT 1 FROM jsonb_array_elements(input->'events') incoming
              WHERE incoming->>'eventId'=source.provider_event_id)))
        AND existing.status IN ('DETECTED','PROTECTED','VERIFICATION_SCHEDULED',
          'WAITING_FOR_CANDIDATE','CONSENT_PENDING','DEVICE_CONNECTING','SYNC_FAILED','EXCLUDED',
          'NO_CREDITS','SUBSCRIPTION_INACTIVE','UNABLE_TO_VERIFY')
        AND NULLIF(input->>'scanWindowStart','') IS NOT NULL
        AND NULLIF(input->>'scanWindowEnd','') IS NOT NULL
        AND existing.scheduled_end>(input->>'scanWindowStart')::TIMESTAMPTZ
        AND existing.scheduled_start<(input->>'scanWindowEnd')::TIMESTAMPTZ
        AND (existing.google_event_updated_at IS NULL
          OR existing.google_event_updated_at<=sync_started) RETURNING existing.id)
    UPDATE credit_reservations reservation SET status='RELEASED',released_at=now(),
      release_reason='INELIGIBLE' FROM stale WHERE reservation.interview_id=stale.id
      AND reservation.status='RESERVED';
    DELETE FROM calendar_interview_sources source USING interviews existing
    WHERE source.google_integration_id=integration.id AND source.interview_id=existing.id
      AND existing.scheduled_end>NULLIF(input->>'scanWindowStart','')::TIMESTAMPTZ
      AND existing.scheduled_start<NULLIF(input->>'scanWindowEnd','')::TIMESTAMPTZ
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(input->'events') incoming
        WHERE incoming->>'eventId'=source.provider_event_id);
  END IF;
  FOR event IN SELECT * FROM jsonb_array_elements(input->'events') LOOP
    interview:=NULL;
    IF event->>'cancelled'='true' OR event->>'excluded'='true' THEN
      WITH removed AS (DELETE FROM calendar_interview_sources source USING interviews existing
        WHERE source.google_integration_id=integration.id
          AND source.provider_event_id=event->>'eventId' AND existing.id=source.interview_id
          AND (existing.google_event_updated_at IS NULL OR
            (NULLIF(event->>'updatedAt','') IS NOT NULL AND
              (event->>'updatedAt')::TIMESTAMPTZ>=existing.google_event_updated_at))
        RETURNING source.interview_id), affected AS (SELECT interview_id AS id FROM removed UNION
        SELECT id FROM interviews WHERE source_google_integration_id IS NULL
          AND organization_id=integration.organization_id
          AND google_calendar_id=integration.selected_calendar_id
          AND google_event_id=event->>'eventId')
      UPDATE interviews existing SET status=CASE WHEN event->>'cancelled'='true'
          OR existing.status='DEVICE_CONNECTING' THEN 'CANCELLED' ELSE 'EXCLUDED' END,
        google_event_updated_at=COALESCE(NULLIF(event->>'updatedAt','')::TIMESTAMPTZ,
          existing.google_event_updated_at),updated_at=now() FROM affected
      WHERE existing.id=affected.id AND NOT EXISTS(SELECT 1 FROM calendar_interview_sources source
          WHERE source.interview_id=existing.id AND NOT (source.google_integration_id=integration.id
            AND source.provider_event_id=event->>'eventId'))
        AND existing.status IN ('DETECTED','PROTECTED','VERIFICATION_SCHEDULED',
          'WAITING_FOR_CANDIDATE','CONSENT_PENDING','DEVICE_CONNECTING','SYNC_FAILED','CANCELLED',
          'EXCLUDED','NO_CREDITS','SUBSCRIPTION_INACTIVE','UNABLE_TO_VERIFY')
        AND (existing.google_event_updated_at IS NULL OR (NULLIF(event->>'updatedAt','') IS NOT NULL
          AND (event->>'updatedAt')::TIMESTAMPTZ>=existing.google_event_updated_at))
      RETURNING existing.id INTO interview;
      UPDATE credit_reservations SET status='RELEASED',released_at=now(),
        release_reason='INELIGIBLE' WHERE interview_id=interview AND status='RESERVED';
      CONTINUE;
    END IF;
    IF NULLIF(event->>'canonicalKey','') IS NOT NULL THEN
      SELECT source.interview_id INTO legacy_interview FROM calendar_interview_sources source
      WHERE source.google_integration_id=integration.id
        AND source.provider_event_id=event->>'eventId';
      SELECT id INTO canonical_interview FROM interviews
      WHERE organization_id=integration.organization_id
        AND calendar_event_key=event->>'canonicalKey' FOR UPDATE;
      IF legacy_interview IS NOT NULL AND canonical_interview IS NOT NULL
          AND legacy_interview<>canonical_interview THEN
        SELECT CASE status WHEN 'REPORT_READY' THEN 190 WHEN 'REPORT_PROCESSING' THEN 180
          WHEN 'FAILED' THEN 175 WHEN 'MEETING_COMPLETED' THEN 170
          WHEN 'MONITORING_INTERRUPTED' THEN 160 WHEN 'MONITORING_ACTIVE' THEN 150
          ELSE CASE WHEN monitoring_started_at IS NOT NULL THEN 140
          WHEN status='CONSENT_DECLINED' THEN 110 ELSE CASE status
          WHEN 'DEVICE_CONNECTING' THEN 60 WHEN 'CONSENT_PENDING' THEN 50
          WHEN 'WAITING_FOR_CANDIDATE' THEN 40 WHEN 'VERIFICATION_SCHEDULED' THEN 30
          WHEN 'PROTECTED' THEN 20 WHEN 'DETECTED' THEN 10 ELSE 0 END END END
          INTO legacy_rank FROM interviews WHERE id=legacy_interview FOR UPDATE;
        SELECT CASE status WHEN 'REPORT_READY' THEN 190 WHEN 'REPORT_PROCESSING' THEN 180
          WHEN 'FAILED' THEN 175 WHEN 'MEETING_COMPLETED' THEN 170
          WHEN 'MONITORING_INTERRUPTED' THEN 160 WHEN 'MONITORING_ACTIVE' THEN 150
          ELSE CASE WHEN monitoring_started_at IS NOT NULL THEN 140
          WHEN status='CONSENT_DECLINED' THEN 110 ELSE CASE status
          WHEN 'DEVICE_CONNECTING' THEN 60 WHEN 'CONSENT_PENDING' THEN 50
          WHEN 'WAITING_FOR_CANDIDATE' THEN 40 WHEN 'VERIFICATION_SCHEDULED' THEN 30
          WHEN 'PROTECTED' THEN 20 WHEN 'DETECTED' THEN 10 ELSE 0 END END END
          INTO canonical_rank FROM interviews WHERE id=canonical_interview;
        survivor:=CASE WHEN canonical_rank>legacy_rank THEN canonical_interview
          ELSE legacy_interview END;
        duplicate:=CASE WHEN survivor=legacy_interview THEN canonical_interview
          ELSE legacy_interview END;
        UPDATE interviews SET status=CASE WHEN status='DEVICE_CONNECTING'
            THEN 'CANCELLED' ELSE 'EXCLUDED' END,
          calendar_event_key=CASE WHEN id=canonical_interview THEN NULL ELSE calendar_event_key END,
          updated_at=now() WHERE id=duplicate AND monitoring_started_at IS NULL
          AND status IN ('DETECTED','PROTECTED','VERIFICATION_SCHEDULED','WAITING_FOR_CANDIDATE',
            'CONSENT_PENDING','DEVICE_CONNECTING','SYNC_FAILED','EXCLUDED','CANCELLED','NO_CREDITS',
            'SUBSCRIPTION_INACTIVE','UNABLE_TO_VERIFY');
        IF FOUND THEN
          UPDATE credit_reservations SET status='RELEASED',released_at=now(),
            release_reason='INELIGIBLE' WHERE interview_id=duplicate AND status='RESERVED';
          UPDATE calendar_interview_sources SET interview_id=survivor WHERE interview_id=duplicate;
          legacy_interview:=survivor;
        ELSIF survivor=legacy_interview THEN
          UPDATE interviews SET calendar_event_key=NULL,updated_at=now()
          WHERE id=canonical_interview;
          UPDATE calendar_interview_sources SET interview_id=survivor
          WHERE interview_id=duplicate;
          legacy_interview:=survivor;
        ELSE
          UPDATE calendar_interview_sources SET interview_id=canonical_interview
          WHERE interview_id=duplicate;
          legacy_interview:=canonical_interview;
        END IF;
      END IF;
      UPDATE interviews existing SET calendar_event_key=event->>'canonicalKey',updated_at=now()
      WHERE existing.id=legacy_interview
        AND existing.calendar_event_key IS DISTINCT FROM event->>'canonicalKey';
    END IF;
    INSERT INTO interviews(organization_id,google_event_id,google_calendar_id,google_meet_code,
      google_meet_url,candidate_email,candidate_name,organizer_email,title,classification_reason,
      scheduled_start,scheduled_end,google_event_updated_at,source_google_integration_id,
      calendar_event_key)
    VALUES(integration.organization_id,event->>'eventId',integration.selected_calendar_id,
      event->>'meetCode',event->>'meetUrl',event->>'candidateEmail',event->>'candidateName',
      event->>'organizerEmail',event->>'title',event->>'reason',(event->>'start')::TIMESTAMPTZ,
      (event->>'end')::TIMESTAMPTZ,(event->>'updatedAt')::TIMESTAMPTZ,integration.id,
      COALESCE(NULLIF(event->>'canonicalKey',''),'google:'||(event->>'eventId')||':'||
        (event->>'meetCode')))
    ON CONFLICT(organization_id,calendar_event_key) WHERE calendar_event_key IS NOT NULL DO UPDATE SET
      google_meet_code=EXCLUDED.google_meet_code,google_meet_url=EXCLUDED.google_meet_url,
      candidate_email=EXCLUDED.candidate_email,candidate_name=EXCLUDED.candidate_name,
      organizer_email=EXCLUDED.organizer_email,title=EXCLUDED.title,
      classification_reason=EXCLUDED.classification_reason,scheduled_start=EXCLUDED.scheduled_start,
      scheduled_end=EXCLUDED.scheduled_end,google_event_updated_at=EXCLUDED.google_event_updated_at,
      source_google_integration_id=EXCLUDED.source_google_integration_id,
      status=CASE WHEN interviews.status IN ('CANCELLED','EXCLUDED') THEN 'DETECTED'
        WHEN interviews.status IN ('WAITING_FOR_CANDIDATE','CONSENT_PENDING','DEVICE_CONNECTING',
          'UNABLE_TO_VERIFY') AND (interviews.scheduled_start IS DISTINCT FROM EXCLUDED.scheduled_start
          OR interviews.scheduled_end IS DISTINCT FROM EXCLUDED.scheduled_end
          OR interviews.candidate_email IS DISTINCT FROM EXCLUDED.candidate_email)
        THEN 'DETECTED' ELSE interviews.status END,updated_at=now()
    WHERE ((EXCLUDED.google_event_updated_at IS NOT NULL AND (interviews.google_event_updated_at
        IS NULL OR EXCLUDED.google_event_updated_at>=interviews.google_event_updated_at))
      OR (EXCLUDED.google_event_updated_at IS NULL AND interviews.google_event_updated_at IS NULL))
      AND interviews.monitoring_started_at IS NULL AND interviews.status NOT IN
        ('MONITORING_ACTIVE','MEETING_COMPLETED','REPORT_PROCESSING','REPORT_READY','CONSENT_DECLINED')
    RETURNING id INTO interview;
    IF interview IS NULL THEN
      SELECT id INTO interview FROM interviews WHERE organization_id=integration.organization_id
        AND calendar_event_key=COALESCE(NULLIF(event->>'canonicalKey',''),
          'google:'||(event->>'eventId')||':'||(event->>'meetCode'));
      IF interview IS NULL THEN CONTINUE; END IF;
      INSERT INTO calendar_interview_sources(google_integration_id,provider_event_id,interview_id)
        VALUES(integration.id,event->>'eventId',interview)
        ON CONFLICT(google_integration_id,provider_event_id) DO UPDATE SET
          interview_id=EXCLUDED.interview_id,last_seen_at=now();
      total:=total+1;
      CONTINUE;
    END IF;
    INSERT INTO calendar_interview_sources(google_integration_id,provider_event_id,interview_id)
      VALUES(integration.id,event->>'eventId',interview)
      ON CONFLICT(google_integration_id,provider_event_id) DO UPDATE SET
        interview_id=EXCLUDED.interview_id,last_seen_at=now();
    DELETE FROM interview_participants WHERE interview_id=interview;
    FOR participant IN SELECT * FROM jsonb_array_elements(event->'participants') LOOP
      INSERT INTO interview_participants(interview_id,email,display_name,participant_type,is_external)
      VALUES(interview,participant->>'email',participant->>'name',participant->>'type',
        (participant->>'external')::BOOLEAN);
    END LOOP;
    total:=total+1;
  END LOOP;
  UPDATE calendar_sync_states SET sync_token=input->>'syncToken',last_synced_at=now(),
    last_sync_started_at=sync_started,last_full_synced_at=CASE
      WHEN COALESCE((input->>'fullSync')::BOOLEAN,false) THEN now() ELSE last_full_synced_at END,
    last_error_code=NULL,updated_at=now() WHERE google_integration_id=integration.id;
  RETURN jsonb_build_object('synced',total);
END $$;

REVOKE ALL ON FUNCTION authenti8_disable_member_calendar() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON TABLE calendar_interview_sources FROM PUBLIC,anon,authenticated;
INSERT INTO schema_migrations(version) VALUES('051_member_calendar_integrations')
  ON CONFLICT DO NOTHING;
COMMIT;
