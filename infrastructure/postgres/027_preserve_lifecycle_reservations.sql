BEGIN;
CREATE OR REPLACE FUNCTION authenti8_sync_monitoring_session() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed_count INTEGER;
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'MONITORING_ACTIVE' THEN
    UPDATE verification_sessions SET status = 'MONITORING_ACTIVE', monitoring_started_at =
      COALESCE(monitoring_started_at, NEW.monitoring_started_at, now())
      WHERE interview_id = NEW.id AND status = 'CONSENTED' AND monitoring_started_at IS NULL;
    GET DIAGNOSTICS changed_count = ROW_COUNT;
    IF changed_count <> 1 THEN RAISE EXCEPTION
      'monitoring requires exactly one consented verification session for interview %', NEW.id
      USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS authenti8_monitoring_session_sync ON interviews;
CREATE TRIGGER authenti8_monitoring_session_sync AFTER UPDATE OF status ON interviews
  FOR EACH ROW EXECUTE FUNCTION authenti8_sync_monitoring_session();
UPDATE verification_sessions session SET status = 'MONITORING_ACTIVE', monitoring_started_at =
  COALESCE(session.monitoring_started_at, interview.monitoring_started_at, now())
FROM interviews interview WHERE session.interview_id = interview.id
  AND interview.status = 'MONITORING_ACTIVE' AND session.status = 'CONSENTED';
CREATE OR REPLACE FUNCTION authenti8_release_credit(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID; interview_row interviews; released INTEGER;
BEGIN
  SELECT organization_id INTO org FROM interviews
    WHERE id = (input->>'interviewId')::UUID;
  IF org IS NULL THEN RETURN jsonb_build_object('released', false); END IF;
  PERFORM id FROM organizations WHERE id = org FOR UPDATE;
  SELECT interview.* INTO interview_row FROM interviews interview
    WHERE interview.id = (input->>'interviewId')::UUID
      AND interview.organization_id = org FOR UPDATE;
  IF interview_row.status IN ('VERIFICATION_SCHEDULED', 'WAITING_FOR_CANDIDATE',
    'CONSENT_PENDING', 'DEVICE_CONNECTING') THEN
    IF NOT authenti8_expire_verification(interview_row.id, ARRAY[interview_row.status],
      'MANUAL_CREDIT_RELEASE') THEN
      RETURN jsonb_build_object('released', false, 'reason', 'INTERVIEW_NOT_RELEASABLE');
    END IF;
    UPDATE credit_reservations SET release_reason = 'MANUAL'
      WHERE interview_id = interview_row.id AND organization_id = org
        AND status = 'RELEASED' AND release_reason = 'INELIGIBLE';
    RETURN jsonb_build_object('released', true);
  END IF;
  IF interview_row.status NOT IN ('DETECTED', 'PROTECTED') THEN
    RETURN jsonb_build_object('released', false, 'reason', 'INTERVIEW_NOT_RELEASABLE');
  END IF;
  UPDATE credit_reservations SET status = 'RELEASED', released_at = now(),
    release_reason = 'MANUAL' WHERE interview_id = interview_row.id
      AND organization_id = org AND status = 'RESERVED';
  GET DIAGNOSTICS released = ROW_COUNT;
  IF released = 1 THEN
    UPDATE interviews SET protection_status = 'RELEASED', updated_at = now()
      WHERE id = interview_row.id;
  END IF;
  RETURN jsonb_build_object('released', released = 1);
END $$;
CREATE OR REPLACE FUNCTION authenti8_reconcile_entitlement(org_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE subscription_status TEXT; entitlement INTEGER := 0; candidate RECORD;
BEGIN
  PERFORM id FROM organizations WHERE id = org_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT status INTO subscription_status FROM subscriptions
    WHERE organization_id = org_id ORDER BY updated_at DESC LIMIT 1;
  IF subscription_status IN ('ACTIVE', 'TRIALING') THEN
    PERFORM authenti8_ensure_allowance(org_id);
    entitlement := GREATEST(authenti8_ledger_balance(org_id), 0);
  END IF;
  -- Every lifecycle mutation takes the interview lock before its reservation lock.
  -- Pre-lock all interviews whose reservations this reconciliation can release.
  PERFORM interview.id FROM interviews interview WHERE interview.id IN (
    SELECT reservation.interview_id FROM credit_reservations reservation
    WHERE reservation.organization_id = org_id AND reservation.status = 'RESERVED'
  ) ORDER BY interview.id FOR UPDATE;
  WITH desired AS (SELECT interview.id FROM interviews interview
    WHERE interview.organization_id = org_id AND interview.status IN ('DETECTED', 'PROTECTED',
      'VERIFICATION_SCHEDULED', 'WAITING_FOR_CANDIDATE', 'CONSENT_PENDING', 'DEVICE_CONNECTING')
      AND interview.scheduled_end + interval '30 minutes' > now()
    ORDER BY interview.status = 'DETECTED', interview.scheduled_start, interview.id LIMIT entitlement)
  UPDATE credit_reservations reservation SET status = 'RELEASED', released_at = now(),
    release_reason = 'ENTITLEMENT' WHERE reservation.organization_id = org_id
    AND reservation.status = 'RESERVED'
    AND NOT EXISTS (SELECT 1 FROM desired WHERE desired.id = reservation.interview_id);
  FOR candidate IN SELECT interview.id, interview.status FROM interviews interview
    WHERE interview.organization_id = org_id AND interview.status IN ('VERIFICATION_SCHEDULED',
      'WAITING_FOR_CANDIDATE', 'CONSENT_PENDING', 'DEVICE_CONNECTING') AND NOT EXISTS (SELECT 1
      FROM credit_reservations reservation WHERE reservation.interview_id = interview.id
        AND reservation.status IN ('RESERVED', 'CONSUMED')) FOR UPDATE LOOP
    PERFORM authenti8_expire_verification(candidate.id, ARRAY[candidate.status], 'ENTITLEMENT_REVOKED');
  END LOOP;
  FOR candidate IN SELECT interview.id FROM interviews interview
    LEFT JOIN credit_reservations reservation ON reservation.interview_id = interview.id
    WHERE interview.organization_id = org_id AND interview.status = 'DETECTED'
      AND interview.scheduled_end > now() AND (reservation.id IS NULL OR (reservation.status =
        'RELEASED' AND reservation.release_reason IN ('ENTITLEMENT', 'INELIGIBLE')))
    ORDER BY interview.scheduled_start, interview.id LIMIT entitlement LOOP
    EXIT WHEN authenti8_available_credits(org_id) <= 0;
    PERFORM authenti8_reserve_credit(jsonb_build_object('interviewId', candidate.id));
  END LOOP;
  UPDATE interviews interview SET protection_status = CASE
    WHEN EXISTS (SELECT 1 FROM credit_reservations reservation WHERE
      reservation.interview_id = interview.id AND reservation.status = 'RESERVED') THEN 'RESERVED'
    WHEN EXISTS (SELECT 1 FROM credit_reservations reservation WHERE
      reservation.interview_id = interview.id AND reservation.status = 'CONSUMED') THEN 'CONSUMED'
    WHEN EXISTS (SELECT 1 FROM credit_reservations reservation WHERE reservation.interview_id =
      interview.id AND reservation.status = 'RELEASED' AND reservation.release_reason = 'MANUAL')
      THEN 'RELEASED' WHEN subscription_status IS NULL OR subscription_status NOT IN ('ACTIVE', 'TRIALING')
      THEN 'UNPROTECTED_SUBSCRIPTION' ELSE 'UNPROTECTED_NO_CREDITS' END, updated_at = now()
  WHERE interview.organization_id = org_id AND interview.status IN ('DETECTED', 'PROTECTED',
    'VERIFICATION_SCHEDULED', 'WAITING_FOR_CANDIDATE', 'CONSENT_PENDING', 'DEVICE_CONNECTING')
    AND interview.scheduled_end + interval '30 minutes' > now();
END $$;
REVOKE ALL ON FUNCTION authenti8_sync_monitoring_session(), authenti8_release_credit(JSONB),
  authenti8_reconcile_entitlement(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_release_credit(JSONB) TO service_role;
INSERT INTO schema_migrations(version) VALUES ('027_preserve_lifecycle_reservations') ON CONFLICT DO NOTHING;
COMMIT;
