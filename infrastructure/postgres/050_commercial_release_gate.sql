BEGIN;

CREATE TABLE commercial_release_checks (
  check_key TEXT PRIMARY KEY,
  passed BOOLEAN NOT NULL,
  detail TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE commercial_release_checks ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION authenti8_commercial_release_readiness(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; checks JSONB;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM platform_staff WHERE user_id=actor AND role='PLATFORM_FOUNDER'
      AND status='ACTIVE') AND NOT EXISTS(SELECT 1 FROM platform_administrators WHERE user_id=actor)
    THEN RETURN NULL; END IF;
  checks:=jsonb_build_array(
    jsonb_build_object('key','active-owner','passed',NOT EXISTS(SELECT 1 FROM organizations org
      WHERE org.status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM organization_members member WHERE
        member.organization_id=org.id AND member.business_role='OWNER' AND member.status='ACTIVE'))),
    jsonb_build_object('key','wallet-solvency','passed',NOT EXISTS(SELECT 1 FROM organizations org
      WHERE (SELECT COALESCE(sum(GREATEST(authenti8_wallet_balance(org.id,member.user_id),0)),0)
        FROM organization_members member WHERE member.organization_id=org.id
          AND member.business_role='HR' AND member.status='ACTIVE')>authenti8_available_credits(org.id))),
    jsonb_build_object('key','payment-attribution','passed',NOT EXISTS(SELECT 1 FROM enterprise_payments
      payment LEFT JOIN credit_transactions credit ON credit.idempotency_key=
        'enterprise-payment:'||payment.provider||':'||payment.provider_event_id WHERE credit.id IS NULL)),
    jsonb_build_object('key','reservation-attribution','passed',NOT EXISTS(SELECT 1 FROM
      credit_reservations reservation WHERE reservation.status IN ('RESERVED','CONSUMED')
        AND reservation.member_user_id IS NULL)),
    jsonb_build_object('key','commercial-dead-letter','passed',NOT EXISTS(SELECT 1 FROM
      commercial_email_outbox WHERE status='FAILED')));
  RETURN jsonb_build_object('ready',NOT EXISTS(SELECT 1 FROM jsonb_array_elements(checks) item
    WHERE NOT (item->>'passed')::BOOLEAN),'checkedAt',now(),'checks',checks);
END $$;

CREATE OR REPLACE FUNCTION authenti8_retain_commercial_contacts(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE changed INTEGER; expired UUID[];
BEGIN
  SELECT array_agg(id) INTO expired FROM commercial_leads WHERE converted_organization_id IS NULL
    AND last_submitted_at<now()-COALESCE(NULLIF(input->>'retentionDays','')::INTEGER,365)
      *interval '1 day' AND normalized_email NOT LIKE 'deleted+%@invalid.local';
  UPDATE commercial_email_outbox SET recipient='deleted+'||lead_id||'@invalid.local',last_error=NULL,
    status=CASE WHEN status IN ('PENDING','PROCESSING') THEN 'CANCELLED' ELSE status END,
    lease_until=NULL WHERE kind='LEAD_CONFIRMATION' AND lead_id=ANY(COALESCE(expired,'{}'::UUID[]));
  UPDATE commercial_leads SET full_name='Deleted contact',email='deleted+'||id||'@invalid.local',
    normalized_email='deleted+'||id||'@invalid.local',attribution='{}'::JSONB,referrer=NULL,
    updated_at=now() WHERE converted_organization_id IS NULL AND last_submitted_at<
      now()-COALESCE(NULLIF(input->>'retentionDays','')::INTEGER,365)*interval '1 day'
      AND normalized_email NOT LIKE 'deleted+%@invalid.local';
  GET DIAGNOSTICS changed=ROW_COUNT;
  INSERT INTO audit_logs(action,target_type,target_id,reason,new_value)
    VALUES('COMMERCIAL_CONTACT_RETENTION','commercial_lead','batch',
      'Expired unconverted commercial contacts anonymized',jsonb_build_object('count',changed));
  RETURN jsonb_build_object('anonymized',changed);
EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('anonymized',0);
END $$;

CREATE OR REPLACE FUNCTION authenti8_meetings_page(input JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; org UUID:=authenti8_user_organization(actor);
  actor_role TEXT; org_timezone TEXT; page_size INTEGER:=25; rows JSONB;
  next_start TIMESTAMPTZ; next_id UUID;
BEGIN
  SELECT business_role INTO actor_role FROM organization_members WHERE organization_id=org
    AND user_id=actor AND status='ACTIVE';
  IF org IS NULL THEN RETURN jsonb_build_object('items','[]'::JSONB,'nextCursor',NULL); END IF;
  IF NULLIF(input->>'limit','') IS NOT NULL THEN
    IF input->>'limit' !~ '^[1-9][0-9]{0,2}$' OR (input->>'limit')::INTEGER>100 THEN
      RETURN jsonb_build_object('items','[]'::JSONB,'nextCursor',NULL,'invalid',true); END IF;
    page_size:=(input->>'limit')::INTEGER;
  END IF;
  SELECT default_timezone INTO org_timezone FROM organizations WHERE id=org;
  WITH filtered AS (SELECT interview.* FROM interviews interview WHERE
    interview.organization_id=org AND interview.status<>'EXCLUDED'
      AND (actor_role IN ('OWNER','MANAGER') OR interview.responsible_member_user_id=actor)
      AND (NULLIF(input->>'from','') IS NULL OR interview.scheduled_start>=(
        (input->>'from')::DATE AT TIME ZONE org_timezone))
      AND (NULLIF(input->>'to','') IS NULL OR interview.scheduled_start<(
        ((input->>'to')::DATE+1) AT TIME ZONE org_timezone))
      AND (NULLIF(input->>'interviewer','') IS NULL OR
        lower(interview.organizer_email)=lower(input->>'interviewer'))
      AND (NULLIF(input->>'candidate','') IS NULL OR lower(COALESCE(interview.candidate_name,'')||
        ' '||interview.candidate_email) LIKE '%'||replace(replace(replace(lower(input->>'candidate'),
          E'\\',E'\\\\'), '%',E'\\%'),'_',E'\\_')||'%' ESCAPE E'\\')
      AND (NULLIF(input->>'cursorStart','') IS NULL OR (interview.scheduled_start,interview.id)<
        ((input->>'cursorStart')::TIMESTAMPTZ,(input->>'cursorId')::UUID))
      AND CASE COALESCE(NULLIF(input->>'status',''),'ALL')
        WHEN 'UPCOMING' THEN interview.scheduled_start>=now() AND interview.status NOT IN
          ('CANCELLED','REPORT_READY','UNABLE_TO_VERIFY')
        WHEN 'LIVE' THEN interview.status IN ('MONITORING_ACTIVE','MONITORING_INTERRUPTED')
        WHEN 'COMPLETED' THEN interview.status IN ('MEETING_COMPLETED','REPORT_PROCESSING','REPORT_READY')
        WHEN 'CONFIRMED' THEN interview.detection_result='CONFIRMED'
        WHEN 'NOT_DETECTED' THEN interview.status='REPORT_READY' AND
          COALESCE(interview.detection_result,'NOT_DETECTED')='NOT_DETECTED'
        WHEN 'UNABLE_TO_VERIFY' THEN interview.status='UNABLE_TO_VERIFY'
        WHEN 'CANCELLED' THEN interview.status='CANCELLED' ELSE true END
      ORDER BY interview.scheduled_start DESC,interview.id DESC LIMIT page_size+1),
    page AS (SELECT * FROM filtered ORDER BY scheduled_start DESC,id DESC LIMIT page_size)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'title',title,'candidateName',candidate_name,
    'candidateEmail',candidate_email,'interviewerEmail',organizer_email,
    'responsibleMemberUserId',responsible_member_user_id,'scheduledStart',scheduled_start,
    'scheduledEnd',scheduled_end,'status',status,'protectionStatus',protection_status,
    'meetUrl',google_meet_url,'classificationReason',classification_reason,
    'consentStatus',consent_status,'verificationDeliveryStatus',verification_delivery_status,
    'detectionResult',detection_result,'coveragePercentage',coverage_percentage,'reportId',report_id)
    ORDER BY scheduled_start DESC,id DESC),'[]'::JSONB),CASE WHEN (SELECT count(*) FROM filtered)>
      page_size THEN (SELECT scheduled_start FROM page ORDER BY scheduled_start,id LIMIT 1) END,
    CASE WHEN (SELECT count(*) FROM filtered)>page_size THEN (SELECT id FROM page
      ORDER BY scheduled_start,id LIMIT 1) END INTO rows,next_start,next_id FROM page;
  RETURN jsonb_build_object('items',rows,'nextCursor',CASE WHEN next_id IS NULL THEN NULL ELSE
    encode(convert_to(next_start::TEXT||'|'||next_id::TEXT,'UTF8'),'base64') END);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow
  OR numeric_value_out_of_range THEN RETURN jsonb_build_object('items','[]'::JSONB,
    'nextCursor',NULL,'invalid',true);
END $$;

CREATE OR REPLACE FUNCTION authenti8_meeting_detail(input JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT authenti8_can_access_interview((input->>'userId')::UUID,
      (input->>'interviewId')::UUID) OR EXISTS(SELECT 1 FROM interviews
      WHERE id=(input->>'interviewId')::UUID AND data_deleted_at IS NOT NULL) THEN RETURN NULL; END IF;
  RETURN authenti8_meeting_detail_retained(input);
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION authenti8_dashboard_overview(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor UUID:=(input->>'userId')::UUID; org UUID:=authenti8_user_organization(actor);
  billing JSONB; stats JSONB; connected BOOLEAN; notifications INTEGER;
BEGIN
  IF org IS NULL THEN RETURN NULL; END IF; billing:=authenti8_billing_summary(input);
  SELECT jsonb_build_object('upcoming',count(*) FILTER(WHERE scheduled_start>=now() AND status IN
    ('PROTECTED','VERIFICATION_SCHEDULED','WAITING_FOR_CANDIDATE','CONSENT_PENDING',
      'DEVICE_CONNECTING','MONITORING_ACTIVE') AND protection_status IN ('RESERVED','CONSUMED')),
    'completed',count(*) FILTER(WHERE status IN
      ('COMPLETED','MEETING_COMPLETED','REPORT_PROCESSING','REPORT_READY')),
    'confirmed',count(*) FILTER(WHERE detection_result='CONFIRMED'),
    'failed',count(*) FILTER(WHERE status IN
      ('FAILED','SYNC_FAILED','UNABLE_TO_VERIFY','MONITORING_INTERRUPTED'))) INTO stats
    FROM interviews interview WHERE interview.organization_id=org
      AND authenti8_can_access_interview(actor,interview.id);
  SELECT count(*)::INTEGER INTO notifications FROM workspace_notifications notice
    WHERE notice.organization_id=org AND notice.read_at IS NULL AND (EXISTS(SELECT 1 FROM
      organization_members member WHERE member.organization_id=org AND member.user_id=actor
        AND member.status='ACTIVE' AND member.business_role IN ('OWNER','MANAGER')) OR
      (notice.interview_id IS NOT NULL AND authenti8_can_access_interview(actor,notice.interview_id)));
  SELECT EXISTS(SELECT 1 FROM google_integrations integration JOIN calendar_sync_states sync
    ON sync.google_integration_id=integration.id WHERE integration.organization_id=org
      AND integration.status='ACTIVE' AND sync.last_synced_at IS NOT NULL
      AND sync.last_error_code IS NULL) INTO connected;
  RETURN billing||stats||jsonb_build_object('integrationActive',connected,
    'notificationCount',notifications,'recentReports',COALESCE((SELECT jsonb_agg(item) FROM
      (SELECT jsonb_build_object('interviewId',interview.id,'title',interview.title,
        'result',report.detection_result,'generatedAt',report.generated_at) item FROM reports report
       JOIN interviews interview ON interview.id=report.interview_id
       WHERE interview.organization_id=org AND authenti8_can_access_interview(actor,interview.id)
       ORDER BY report.generated_at DESC LIMIT 5) recent),'[]'::JSONB));
END $$;

CREATE OR REPLACE FUNCTION authenti8_notifications(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',notice.id,'kind',notice.kind,
    'title',notice.title,'message',notice.message,'severity',notice.severity,
    'linkPath',notice.link_path,'readAt',notice.read_at,'createdAt',notice.created_at)
    ORDER BY notice.created_at DESC),'[]'::JSONB) FROM (SELECT item.*
    FROM workspace_notifications item WHERE item.organization_id=authenti8_user_organization(
      (input->>'userId')::UUID) AND (EXISTS(SELECT 1 FROM organization_members member WHERE
        member.organization_id=item.organization_id AND member.user_id=(input->>'userId')::UUID
        AND member.status='ACTIVE' AND member.business_role IN ('OWNER','MANAGER')) OR
      (item.interview_id IS NOT NULL AND
        authenti8_can_access_interview((input->>'userId')::UUID,item.interview_id)))
    ORDER BY item.created_at DESC LIMIT 100) notice
$$;

CREATE OR REPLACE FUNCTION authenti8_acknowledge_notifications(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor UUID:=(input->>'userId')::UUID; org UUID:=authenti8_user_organization(actor);
  acknowledged INTEGER:=0;
BEGIN
  IF org IS NULL THEN RETURN NULL; END IF;
  UPDATE workspace_notifications notice SET read_at=now() WHERE notice.organization_id=org
    AND notice.read_at IS NULL AND (EXISTS(SELECT 1 FROM organization_members member WHERE
      member.organization_id=org AND member.user_id=actor AND member.status='ACTIVE'
      AND member.business_role IN ('OWNER','MANAGER')) OR (notice.interview_id IS NOT NULL
        AND authenti8_can_access_interview(actor,notice.interview_id)));
  GET DIAGNOSTICS acknowledged=ROW_COUNT;
  RETURN jsonb_build_object('acknowledged',acknowledged);
END $$;

CREATE OR REPLACE FUNCTION authenti8_notification_fanout() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.severity IN ('WARNING','CRITICAL') THEN
    INSERT INTO notification_email_outbox(notification_id,recipient)
    SELECT NEW.id,account.email FROM organization_members member JOIN users account
      ON account.id=member.user_id WHERE member.organization_id=NEW.organization_id
      AND member.status='ACTIVE' AND account.status='ACTIVE' AND
      (member.business_role IN ('OWNER','MANAGER') OR (NEW.interview_id IS NOT NULL
        AND member.business_role='HR' AND EXISTS(SELECT 1 FROM interviews interview
          WHERE interview.id=NEW.interview_id AND interview.responsible_member_user_id=member.user_id)))
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION authenti8_notification_email_authorized(
  notification UUID, recipient_email TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS(SELECT 1 FROM workspace_notifications notice
    JOIN organization_members member ON member.organization_id=notice.organization_id
    JOIN users account ON account.id=member.user_id
    WHERE notice.id=notification AND account.email=recipient_email
      AND member.status='ACTIVE' AND account.status='ACTIVE'
      AND (member.business_role IN ('OWNER','MANAGER') OR (notice.interview_id IS NOT NULL
        AND member.business_role='HR' AND EXISTS(SELECT 1 FROM interviews interview
          WHERE interview.id=notice.interview_id
            AND interview.responsible_member_user_id=member.user_id))))
$$;

UPDATE notification_email_outbox outbox SET status='FAILED',lease_until=NULL,
  last_error='Recipient no longer authorized for notification'
WHERE outbox.status IN ('PENDING','PROCESSING')
  AND NOT authenti8_notification_email_authorized(outbox.notification_id,outbox.recipient);

CREATE OR REPLACE FUNCTION authenti8_claim_notification_email() RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE result JSONB;
BEGIN
  UPDATE notification_email_outbox outbox SET status='FAILED',lease_until=NULL,
    last_error='Recipient no longer authorized for notification'
    WHERE outbox.status IN ('PENDING','PROCESSING')
      AND NOT authenti8_notification_email_authorized(outbox.notification_id,outbox.recipient);
  UPDATE notification_email_outbox SET status='FAILED',lease_until=NULL,
    last_error=COALESCE(last_error,'Delivery lease expired after maximum attempts')
    WHERE status='PROCESSING' AND lease_until<=now() AND attempts>=5;
  WITH selected AS (SELECT outbox.id FROM notification_email_outbox outbox
    WHERE ((outbox.status='PENDING' AND outbox.available_at<=now()) OR
      (outbox.status='PROCESSING' AND outbox.lease_until<=now() AND outbox.attempts<5))
      AND authenti8_notification_email_authorized(outbox.notification_id,outbox.recipient)
    ORDER BY outbox.created_at FOR UPDATE SKIP LOCKED LIMIT 1), claimed AS (
    UPDATE notification_email_outbox outbox SET status='PROCESSING',attempts=attempts+1,
      lease_until=now()+interval '30 seconds' FROM selected WHERE outbox.id=selected.id
      RETURNING outbox.*)
  SELECT jsonb_build_object('id',claimed.id,'attempts',claimed.attempts,
    'recipient',claimed.recipient,'title',notice.title,'message',notice.message,
    'linkPath',notice.link_path) INTO result FROM claimed
    JOIN workspace_notifications notice ON notice.id=claimed.notification_id;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION authenti8_validate_notification_email(input JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE valid BOOLEAN;
BEGIN
  SELECT authenti8_notification_email_authorized(outbox.notification_id,outbox.recipient)
    INTO valid FROM notification_email_outbox outbox WHERE outbox.id=(input->>'id')::UUID
      AND outbox.status='PROCESSING' AND outbox.attempts=(input->>'attempts')::INTEGER FOR UPDATE;
  IF COALESCE(valid,false)=false THEN UPDATE notification_email_outbox
    SET status='FAILED',lease_until=NULL,last_error='Recipient no longer authorized for notification'
    WHERE id=(input->>'id')::UUID AND status='PROCESSING'
      AND attempts=(input->>'attempts')::INTEGER; END IF;
  RETURN COALESCE(valid,false);
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION authenti8_recruiter_logs(input JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT authenti8_can_access_interview((input->>'userId')::UUID,
      (input->>'interviewId')::UUID) OR NOT EXISTS(SELECT 1 FROM interviews interview WHERE
      interview.id=(input->>'interviewId')::UUID
      AND interview.organization_id=(input->>'organizationId')::UUID AND now() BETWEEN
      interview.scheduled_start-interval '15 minutes' AND interview.scheduled_end+interval '30 minutes')
    THEN RETURN jsonb_build_object('authorized',false,'events','[]'::JSONB); END IF;
  RETURN jsonb_build_object('authorized',true,'events',COALESCE((SELECT jsonb_agg(row_data) FROM
    (SELECT id sequence,kind,message,occurred_at "occurredAt",metadata FROM recruiter_live_events
      WHERE interview_id=(input->>'interviewId')::UUID
        AND id>COALESCE((input->>'after')::BIGINT,0) ORDER BY id LIMIT 500) row_data),'[]'::JSONB));
EXCEPTION WHEN invalid_text_representation THEN
  RETURN jsonb_build_object('authorized',false,'events','[]'::JSONB);
END $$;

CREATE OR REPLACE FUNCTION authenti8_recruiter_meeting(input JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE result JSONB;
BEGIN
  SELECT jsonb_build_object('protected',true,'interviewId',interview.id,
    'candidateName',interview.candidate_name,'status',interview.status,'platform',device.platform,
    'coveragePercentage',session.coverage_percentage,'detectionResult',COALESCE(
      interview.detection_result,'NOT_DETECTED')) INTO result FROM interviews interview
  LEFT JOIN LATERAL(SELECT candidate.* FROM verification_sessions candidate WHERE
    candidate.interview_id=interview.id ORDER BY candidate.created_at DESC,candidate.id DESC
    LIMIT 1) session ON true LEFT JOIN candidate_devices device ON
      device.verification_session_id=session.id AND device.revoked_at IS NULL
  WHERE interview.google_meet_code=lower(input->>'meetCode')
    AND interview.organization_id=(input->>'organizationId')::UUID
    AND authenti8_can_access_interview((input->>'userId')::UUID,interview.id)
    AND interview.status NOT IN ('EXCLUDED','CANCELLED') AND now() BETWEEN
      interview.scheduled_start-interval '15 minutes' AND interview.scheduled_end+interval '30 minutes'
  ORDER BY interview.scheduled_start DESC LIMIT 1;
  RETURN COALESCE(result,jsonb_build_object('protected',false));
EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('protected',false);
END $$;

CREATE OR REPLACE FUNCTION authenti8_recruiter_end_monitoring(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE session_id UUID;
BEGIN
  IF NOT authenti8_can_access_interview((input->>'userId')::UUID,
      (input->>'interviewId')::UUID) THEN
    RETURN jsonb_build_object('stopped',false,'reason','SESSION_UNAVAILABLE'); END IF;
  SELECT id INTO session_id FROM verification_sessions WHERE
    interview_id=(input->>'interviewId')::UUID AND status='MONITORING_ACTIVE'
    ORDER BY created_at DESC LIMIT 1;
  IF session_id IS NULL THEN RETURN jsonb_build_object('stopped',false,
    'reason','SESSION_UNAVAILABLE'); END IF;
  RETURN authenti8_finish_monitoring(jsonb_build_object('verificationSessionId',session_id,
    'reason','RECRUITER_ENDED'));
EXCEPTION WHEN invalid_text_representation THEN
  RETURN jsonb_build_object('stopped',false,'reason','SESSION_UNAVAILABLE');
END $$;

REVOKE ALL ON TABLE commercial_release_checks FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION authenti8_commercial_release_readiness(JSONB),
  authenti8_retain_commercial_contacts(JSONB),authenti8_meetings_page(JSONB),
  authenti8_meeting_detail(JSONB),authenti8_dashboard_overview(JSONB),
  authenti8_notifications(JSONB),authenti8_acknowledge_notifications(JSONB),
  authenti8_recruiter_logs(JSONB),authenti8_recruiter_meeting(JSONB),
  authenti8_recruiter_end_monitoring(JSONB),authenti8_notification_fanout(),
  authenti8_notification_email_authorized(UUID,TEXT),authenti8_validate_notification_email(JSONB)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION authenti8_commercial_release_readiness(JSONB),
  authenti8_retain_commercial_contacts(JSONB),authenti8_meetings_page(JSONB),
  authenti8_meeting_detail(JSONB),authenti8_dashboard_overview(JSONB),
  authenti8_notifications(JSONB),authenti8_acknowledge_notifications(JSONB),
  authenti8_recruiter_logs(JSONB),authenti8_recruiter_meeting(JSONB),
  authenti8_recruiter_end_monitoring(JSONB),authenti8_validate_notification_email(JSONB)
  TO service_role;
INSERT INTO schema_migrations(version) VALUES ('050_commercial_release_gate');
COMMIT;
