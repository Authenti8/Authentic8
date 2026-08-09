BEGIN;

ALTER TABLE interviews ADD COLUMN protection_status TEXT NOT NULL DEFAULT 'PENDING'
  CHECK (protection_status IN ('PENDING', 'RESERVED', 'CONSUMED', 'RELEASED',
    'UNPROTECTED_NO_CREDITS', 'UNPROTECTED_SUBSCRIPTION'));

CREATE OR REPLACE FUNCTION authenti8_reserve_credit(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID; balance INTEGER; reservation credit_reservations; interview_row interviews;
BEGIN
  SELECT interview.organization_id INTO org FROM interviews interview
  WHERE interview.id = (input->>'interviewId')::UUID;
  IF org IS NULL THEN RETURN NULL; END IF;
  PERFORM id FROM organizations WHERE id = org FOR UPDATE;
  SELECT interview.* INTO interview_row FROM interviews interview
  WHERE interview.id = (input->>'interviewId')::UUID
    AND interview.organization_id = org FOR UPDATE;
  IF interview_row.id IS NULL THEN RETURN NULL; END IF;
  IF interview_row.status <> 'DETECTED' THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'INTERVIEW_NOT_ELIGIBLE');
  END IF;
  SELECT * INTO reservation FROM credit_reservations
  WHERE interview_id = interview_row.id AND organization_id = org FOR UPDATE;
  IF reservation.status = 'RELEASED' AND reservation.release_reason = 'MANUAL' THEN
    UPDATE interviews SET protection_status = 'RELEASED', updated_at = now()
    WHERE id = interview_row.id;
    RETURN jsonb_build_object('reserved', false, 'reason', 'MANUALLY_RELEASED');
  END IF;
  -- Reservations may be created ahead of time, but never after the meeting ends.
  IF interview_row.scheduled_end <= now() THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'INTERVIEW_OUTSIDE_WINDOW');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subscriptions WHERE organization_id = org
    AND status IN ('ACTIVE', 'TRIALING')) THEN
    UPDATE interviews SET protection_status = 'UNPROTECTED_SUBSCRIPTION', updated_at = now()
    WHERE id = interview_row.id;
    RETURN jsonb_build_object('reserved', false, 'reason', 'INACTIVE_SUBSCRIPTION');
  END IF;
  PERFORM authenti8_ensure_allowance(org);
  IF reservation.status = 'RESERVED' THEN
    UPDATE interviews SET protection_status = 'RESERVED', updated_at = now()
    WHERE id = interview_row.id;
    RETURN jsonb_build_object('reserved', true, 'reservationId', reservation.id);
  ELSIF reservation.status = 'CONSUMED' THEN
    UPDATE interviews SET protection_status = 'CONSUMED', updated_at = now()
    WHERE id = interview_row.id;
    RETURN jsonb_build_object('reserved', false, 'reason', 'ALREADY_CONSUMED');
  END IF;
  balance := authenti8_available_credits(org);
  IF balance <= 0 THEN
    UPDATE interviews SET protection_status = 'UNPROTECTED_NO_CREDITS', updated_at = now()
    WHERE id = interview_row.id;
    RETURN jsonb_build_object('reserved', false, 'reason', 'NO_CREDITS');
  END IF;
  IF reservation.id IS NULL THEN
    INSERT INTO credit_reservations(organization_id, interview_id)
    VALUES (org, interview_row.id) RETURNING * INTO reservation;
  ELSE
    UPDATE credit_reservations SET status = 'RESERVED', reserved_at = now(),
      consumed_at = NULL, released_at = NULL, release_reason = NULL
    WHERE id = reservation.id RETURNING * INTO reservation;
  END IF;
  UPDATE interviews SET protection_status = 'RESERVED', updated_at = now()
  WHERE id = interview_row.id;
  RETURN jsonb_build_object('reserved', true, 'reservationId', reservation.id);
END $$;

CREATE OR REPLACE FUNCTION authenti8_consume_credit(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE reservation credit_reservations; interview_row interviews; period_key TEXT;
  org UUID; allowance_balance INTEGER; extra_balance INTEGER; transaction_kind TEXT;
BEGIN
  SELECT interview.organization_id INTO org FROM interviews interview
  WHERE interview.id = (input->>'interviewId')::UUID;
  IF org IS NULL THEN RETURN NULL; END IF;
  PERFORM id FROM organizations WHERE id = org FOR UPDATE;
  SELECT interview.* INTO interview_row FROM interviews interview
  WHERE interview.id = (input->>'interviewId')::UUID
    AND interview.organization_id = org FOR UPDATE;
  IF interview_row.id IS NULL THEN RETURN NULL; END IF;
  SELECT reservation_row.* INTO reservation FROM credit_reservations reservation_row
  WHERE reservation_row.interview_id = interview_row.id
    AND reservation_row.organization_id = org FOR UPDATE;
  IF reservation.id IS NULL THEN RETURN NULL; END IF;
  IF reservation.status = 'CONSUMED' THEN
    UPDATE interviews SET protection_status = 'CONSUMED' WHERE id = interview_row.id;
    RETURN jsonb_build_object('consumed', true);
  END IF;
  IF reservation.status = 'RELEASED' THEN
    UPDATE interviews SET protection_status = 'RELEASED' WHERE id = interview_row.id;
    RETURN jsonb_build_object('consumed', false, 'reason', 'RELEASED');
  END IF;
  IF interview_row.organization_id <> reservation.organization_id
    OR interview_row.status <> 'DETECTED' THEN
    RETURN jsonb_build_object('consumed', false, 'reason', 'INTERVIEW_NOT_ELIGIBLE');
  END IF;
  -- Monitoring can start shortly before a call and tolerates modest interview overrun.
  IF now() < interview_row.scheduled_start - interval '15 minutes'
    OR now() > interview_row.scheduled_end + interval '30 minutes' THEN
    UPDATE credit_reservations SET status = 'RELEASED', released_at = now(),
      release_reason = 'INELIGIBLE' WHERE id = reservation.id AND status = 'RESERVED';
    UPDATE interviews SET protection_status = 'RELEASED', updated_at = now()
    WHERE id = interview_row.id;
    RETURN jsonb_build_object('consumed', false, 'reason', 'INTERVIEW_OUTSIDE_WINDOW');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subscriptions subscription
    WHERE subscription.organization_id = reservation.organization_id
      AND subscription.status IN ('ACTIVE', 'TRIALING')) THEN
    UPDATE interviews SET protection_status = 'UNPROTECTED_SUBSCRIPTION'
    WHERE id = interview_row.id;
    RETURN jsonb_build_object('consumed', false, 'reason', 'INACTIVE_SUBSCRIPTION');
  END IF;
  period_key := authenti8_period_key(reservation.organization_id);
  SELECT COALESCE(sum(amount), 0) INTO allowance_balance FROM credit_transactions
  WHERE organization_id = reservation.organization_id
    AND kind IN ('MONTHLY_ALLOWANCE', 'PLAN_UPGRADE', 'ALLOWANCE_CONSUMED')
    AND reference_id = period_key;
  SELECT COALESCE(sum(amount), 0) INTO extra_balance FROM credit_transactions
  WHERE organization_id = reservation.organization_id
    AND kind IN ('EXTRA_PURCHASE', 'EXTRA_CONSUMED', 'EXTRA_REVERSAL');
  IF allowance_balance <= 0 AND extra_balance <= 0 THEN
    UPDATE interviews SET protection_status = 'UNPROTECTED_NO_CREDITS'
    WHERE id = interview_row.id;
    RETURN jsonb_build_object('consumed', false, 'reason', 'NO_CREDITS');
  END IF;
  UPDATE interviews SET monitoring_started_at = COALESCE(monitoring_started_at, now()),
    status = 'MONITORING_ACTIVE', protection_status = 'CONSUMED', updated_at = now()
  WHERE id = reservation.interview_id AND organization_id = reservation.organization_id
    AND status = 'DETECTED';
  transaction_kind := CASE WHEN allowance_balance > 0
    THEN 'ALLOWANCE_CONSUMED' ELSE 'EXTRA_CONSUMED' END;
  UPDATE credit_reservations SET status = 'CONSUMED', consumed_at = now()
  WHERE id = reservation.id AND status = 'RESERVED';
  INSERT INTO credit_transactions(organization_id, amount, kind, reference_id, idempotency_key)
  VALUES (reservation.organization_id, -1, transaction_kind,
    CASE WHEN transaction_kind = 'ALLOWANCE_CONSUMED' THEN period_key
      ELSE reservation.interview_id::TEXT END,
    'consume:' || reservation.interview_id) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('consumed', true);
END $$;

CREATE OR REPLACE FUNCTION authenti8_release_credit(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE released INTEGER;
BEGIN
  UPDATE credit_reservations SET status = 'RELEASED', released_at = now(),
    release_reason = 'MANUAL'
  WHERE interview_id = (input->>'interviewId')::UUID AND status = 'RESERVED';
  GET DIAGNOSTICS released = ROW_COUNT;
  IF released = 1 THEN
    UPDATE interviews SET protection_status = 'RELEASED', updated_at = now()
    WHERE id = (input->>'interviewId')::UUID;
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
  WITH desired AS (
    SELECT interview.id FROM interviews interview
    WHERE interview.organization_id = org_id AND interview.status = 'DETECTED'
      AND (interview.scheduled_end > now() OR (
        interview.scheduled_end + interval '30 minutes' > now()
        AND EXISTS (SELECT 1 FROM credit_reservations reservation
          WHERE reservation.interview_id = interview.id
            AND reservation.status = 'RESERVED')
      ))
    ORDER BY interview.scheduled_start, interview.id LIMIT entitlement
  )
  UPDATE credit_reservations reservation SET status = 'RELEASED', released_at = now(),
    release_reason = 'ENTITLEMENT'
  WHERE reservation.organization_id = org_id AND reservation.status = 'RESERVED'
    AND NOT EXISTS (SELECT 1 FROM desired WHERE desired.id = reservation.interview_id);
  FOR candidate IN
    SELECT interview.id FROM interviews interview
    LEFT JOIN credit_reservations reservation ON reservation.interview_id = interview.id
    WHERE interview.organization_id = org_id AND interview.status = 'DETECTED'
      AND interview.scheduled_end > now()
      AND (reservation.id IS NULL OR (reservation.status = 'RELEASED'
        AND reservation.release_reason IN ('ENTITLEMENT', 'INELIGIBLE')))
    ORDER BY interview.scheduled_start, interview.id LIMIT entitlement
  LOOP
    EXIT WHEN authenti8_available_credits(org_id) <= 0;
    PERFORM authenti8_reserve_credit(jsonb_build_object('interviewId', candidate.id));
  END LOOP;
  UPDATE interviews interview SET protection_status = CASE
    WHEN EXISTS (SELECT 1 FROM credit_reservations reservation
      WHERE reservation.interview_id = interview.id AND reservation.status = 'RESERVED')
      THEN 'RESERVED'
    WHEN EXISTS (SELECT 1 FROM credit_reservations reservation
      WHERE reservation.interview_id = interview.id AND reservation.status = 'CONSUMED')
      THEN 'CONSUMED'
    WHEN EXISTS (SELECT 1 FROM credit_reservations reservation
      WHERE reservation.interview_id = interview.id AND reservation.status = 'RELEASED'
        AND reservation.release_reason = 'MANUAL') THEN 'RELEASED'
    WHEN subscription_status NOT IN ('ACTIVE', 'TRIALING')
      THEN 'UNPROTECTED_SUBSCRIPTION'
    ELSE 'UNPROTECTED_NO_CREDITS' END, updated_at = now()
  WHERE interview.organization_id = org_id AND interview.status = 'DETECTED'
    AND interview.scheduled_end > now();
END $$;

CREATE OR REPLACE FUNCTION authenti8_interview_credit_trigger() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'DETECTED' AND NEW.scheduled_end > now() THEN
    IF NOT EXISTS (SELECT 1 FROM credit_reservations
      WHERE interview_id = NEW.id AND status = 'RELEASED' AND release_reason = 'MANUAL') THEN
      PERFORM authenti8_reserve_credit(jsonb_build_object('interviewId', NEW.id));
    ELSE
      UPDATE interviews SET protection_status = 'RELEASED' WHERE id = NEW.id;
    END IF;
  ELSIF NEW.status = 'DETECTED'
    OR NEW.status IN ('CANCELLED', 'EXCLUDED', 'SYNC_FAILED') THEN
    UPDATE credit_reservations SET status = 'RELEASED', released_at = now(),
      release_reason = 'INELIGIBLE'
    WHERE interview_id = NEW.id AND status = 'RESERVED';
    UPDATE interviews SET protection_status = 'RELEASED', updated_at = now() WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION authenti8_list_interviews(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'title', title,
    'candidateEmail', candidate_email, 'scheduledStart', scheduled_start,
    'scheduledEnd', scheduled_end, 'status', status,
    'protectionStatus', protection_status, 'meetUrl', google_meet_url)
    ORDER BY scheduled_start), '[]'::jsonb)
  FROM interviews interview
  WHERE organization_id = authenti8_user_organization((input->>'userId')::UUID)
    AND ((scheduled_start >= now() - interval '30 days' AND status <> 'EXCLUDED')
      OR EXISTS (SELECT 1 FROM reports report WHERE report.interview_id = interview.id))
$$;

UPDATE interviews interview SET protection_status = CASE
  WHEN reservation.status = 'RESERVED' THEN 'RESERVED'
  WHEN reservation.status = 'CONSUMED' THEN 'CONSUMED'
  WHEN reservation.status = 'RELEASED' THEN 'RELEASED'
  WHEN EXISTS (SELECT 1 FROM subscriptions subscription
    WHERE subscription.organization_id = interview.organization_id
      AND subscription.status IN ('ACTIVE', 'TRIALING'))
    THEN 'UNPROTECTED_NO_CREDITS'
  ELSE 'UNPROTECTED_SUBSCRIPTION' END
FROM (SELECT target.id, existing.status FROM interviews target
  LEFT JOIN credit_reservations existing ON existing.interview_id = target.id) reservation
WHERE interview.id = reservation.id;

REVOKE ALL ON FUNCTION authenti8_reserve_credit(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_consume_credit(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_release_credit(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_reconcile_entitlement(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_interview_credit_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_list_interviews(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_reserve_credit(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION authenti8_consume_credit(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION authenti8_release_credit(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION authenti8_list_interviews(JSONB) TO service_role;

SELECT authenti8_reconcile_all_credits('{}'::JSONB);
INSERT INTO schema_migrations(version) VALUES ('018_interview_protection_state');
COMMIT;
