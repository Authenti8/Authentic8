BEGIN;

ALTER TABLE interviews ADD COLUMN responsible_member_user_id UUID REFERENCES users(id);
ALTER TABLE credit_reservations
  ADD COLUMN member_user_id UUID REFERENCES users(id),
  ADD COLUMN wallet_version INTEGER NOT NULL DEFAULT 1 CHECK (wallet_version > 0);

UPDATE interviews interview SET responsible_member_user_id=(SELECT member.user_id
  FROM organization_members member WHERE member.organization_id=interview.organization_id
    AND member.business_role='OWNER' AND member.status='ACTIVE' ORDER BY member.created_at LIMIT 1)
WHERE responsible_member_user_id IS NULL;
UPDATE credit_reservations reservation SET member_user_id=interview.responsible_member_user_id
  FROM interviews interview WHERE interview.id=reservation.interview_id;

CREATE OR REPLACE FUNCTION authenti8_assign_interview_owner() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.responsible_member_user_id IS NULL THEN
    SELECT member.user_id INTO NEW.responsible_member_user_id FROM organization_members member
      JOIN users account ON account.id=member.user_id WHERE member.organization_id=NEW.organization_id
      AND member.status='ACTIVE' AND account.normalized_email=lower(NEW.organizer_email)
      ORDER BY member.created_at LIMIT 1;
  END IF;
  IF NEW.responsible_member_user_id IS NULL THEN SELECT user_id INTO NEW.responsible_member_user_id
    FROM organization_members WHERE organization_id=NEW.organization_id AND business_role='OWNER'
      AND status='ACTIVE' ORDER BY created_at LIMIT 1; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authenti8_interview_owner_before_write BEFORE INSERT OR UPDATE OF organizer_email
ON interviews FOR EACH ROW EXECUTE FUNCTION authenti8_assign_interview_owner();

CREATE OR REPLACE FUNCTION authenti8_wallet_reservation_transition() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE role_name TEXT;
BEGIN
  IF OLD.status='RESERVED' AND NEW.status IN ('CONSUMED','RELEASED') THEN
    SELECT business_role INTO role_name FROM organization_members WHERE
      organization_id=NEW.organization_id AND user_id=OLD.member_user_id;
    IF role_name='HR' THEN
      INSERT INTO hr_wallet_transactions(organization_id,member_user_id,interview_id,amount,kind,
        actor_user_id,reason,idempotency_key) VALUES(NEW.organization_id,OLD.member_user_id,
        NEW.interview_id,CASE NEW.status WHEN 'RELEASED' THEN 1 ELSE 0 END,
        CASE NEW.status WHEN 'RELEASED' THEN 'INTERVIEW_RELEASED' ELSE 'INTERVIEW_CONSUMED' END,
        NULL,CASE NEW.status WHEN 'RELEASED' THEN 'Interview reservation released'
          ELSE 'Interview reservation consumed' END,
        'wallet-'||lower(NEW.status)||':'||NEW.interview_id||':'||OLD.wallet_version)
      ON CONFLICT(idempotency_key) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authenti8_wallet_reservation_after_update AFTER UPDATE OF status ON credit_reservations
FOR EACH ROW EXECUTE FUNCTION authenti8_wallet_reservation_transition();

CREATE OR REPLACE FUNCTION authenti8_reserve_credit(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE org UUID; balance INTEGER; reservation credit_reservations; interview_row interviews;
  member organization_members;
BEGIN
  SELECT * INTO interview_row FROM interviews WHERE id=(input->>'interviewId')::UUID FOR UPDATE;
  org:=interview_row.organization_id; IF org IS NULL THEN RETURN NULL; END IF;
  PERFORM id FROM organizations WHERE id=org FOR UPDATE;
  SELECT * INTO member FROM organization_members WHERE organization_id=org
    AND user_id=interview_row.responsible_member_user_id AND status='ACTIVE' FOR UPDATE;
  IF interview_row.status<>'DETECTED' THEN
    RETURN jsonb_build_object('reserved',false,'reason','INTERVIEW_NOT_ELIGIBLE'); END IF;
  IF member.user_id IS NULL THEN
    RETURN jsonb_build_object('reserved',false,'reason','INTERVIEW_OWNER_INELIGIBLE'); END IF;
  SELECT * INTO reservation FROM credit_reservations WHERE interview_id=interview_row.id FOR UPDATE;
  IF reservation.status='RELEASED' AND reservation.release_reason='MANUAL' THEN
    UPDATE interviews SET protection_status='RELEASED',updated_at=now() WHERE id=interview_row.id;
    RETURN jsonb_build_object('reserved',false,'reason','MANUALLY_RELEASED'); END IF;
  IF interview_row.scheduled_end<=now() THEN
    RETURN jsonb_build_object('reserved',false,'reason','INTERVIEW_OUTSIDE_WINDOW'); END IF;
  IF NOT EXISTS(SELECT 1 FROM subscriptions WHERE organization_id=org
      AND status IN ('ACTIVE','TRIALING')) THEN
    UPDATE interviews SET protection_status='UNPROTECTED_SUBSCRIPTION',updated_at=now()
      WHERE id=interview_row.id;
    RETURN jsonb_build_object('reserved',false,'reason','INACTIVE_SUBSCRIPTION'); END IF;
  PERFORM authenti8_ensure_allowance(org);
  IF reservation.status='RESERVED' THEN RETURN jsonb_build_object('reserved',true,
    'reservationId',reservation.id); END IF;
  IF reservation.status='CONSUMED' THEN RETURN jsonb_build_object('reserved',false,
    'reason','ALREADY_CONSUMED'); END IF;
  balance:=authenti8_available_credits(org);
  IF balance<=0 THEN UPDATE interviews SET protection_status='UNPROTECTED_NO_CREDITS',updated_at=now()
    WHERE id=interview_row.id; RETURN jsonb_build_object('reserved',false,'reason','NO_CREDITS'); END IF;
  IF member.business_role='HR' AND authenti8_wallet_balance(org,member.user_id)<=0 THEN
    UPDATE interviews SET protection_status='UNPROTECTED_NO_CREDITS',updated_at=now()
      WHERE id=interview_row.id;
    RETURN jsonb_build_object('reserved',false,'reason','NO_HR_ALLOCATION'); END IF;
  IF reservation.id IS NULL THEN
    INSERT INTO credit_reservations(organization_id,interview_id,member_user_id)
      VALUES(org,interview_row.id,member.user_id) RETURNING * INTO reservation;
  ELSE UPDATE credit_reservations SET status='RESERVED',reserved_at=now(),consumed_at=NULL,
    released_at=NULL,release_reason=NULL,member_user_id=member.user_id,wallet_version=wallet_version+1
    WHERE id=reservation.id RETURNING * INTO reservation; END IF;
  IF member.business_role='HR' THEN INSERT INTO hr_wallet_transactions(organization_id,
    member_user_id,interview_id,amount,kind,actor_user_id,reason,idempotency_key)
    VALUES(org,member.user_id,interview_row.id,-1,'INTERVIEW_RESERVED',NULL,
      'Interview allocation reserved','wallet-reserved:'||interview_row.id||':'||reservation.wallet_version);
  END IF;
  UPDATE interviews SET protection_status='RESERVED',updated_at=now() WHERE id=interview_row.id;
  RETURN jsonb_build_object('reserved',true,'reservationId',reservation.id);
END $$;

CREATE OR REPLACE FUNCTION authenti8_reassign_interview(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; target UUID := (input->>'memberUserId')::UUID;
  interview_row interviews; reservation credit_reservations; old_member organization_members;
  new_member organization_members; actor_member organization_members;
BEGIN
  SELECT * INTO interview_row FROM interviews WHERE id=(input->>'interviewId')::UUID FOR UPDATE;
  SELECT * INTO actor_member FROM organization_members WHERE organization_id=interview_row.organization_id
    AND user_id=actor AND business_role IN ('OWNER','MANAGER') AND status='ACTIVE';
  SELECT * INTO new_member FROM organization_members WHERE organization_id=interview_row.organization_id
    AND user_id=target AND status='ACTIVE';
  IF actor_member.user_id IS NULL OR new_member.user_id IS NULL THEN
    RETURN jsonb_build_object('updated',false,'reason','NOT_AUTHORIZED'); END IF;
  SELECT * INTO reservation FROM credit_reservations WHERE interview_id=interview_row.id FOR UPDATE;
  IF reservation.status='CONSUMED' THEN RETURN jsonb_build_object('updated',false,
    'reason','ALREADY_CONSUMED'); END IF;
  SELECT * INTO old_member FROM organization_members WHERE organization_id=interview_row.organization_id
    AND user_id=interview_row.responsible_member_user_id;
  IF reservation.status='RESERVED' AND new_member.business_role='HR'
      AND authenti8_wallet_balance(interview_row.organization_id,target)<=0 THEN
    RETURN jsonb_build_object('updated',false,'reason','NO_HR_ALLOCATION'); END IF;
  IF reservation.status='RESERVED' AND old_member.business_role='HR' THEN
    INSERT INTO hr_wallet_transactions(organization_id,member_user_id,interview_id,amount,kind,
      actor_user_id,reason,idempotency_key) VALUES(interview_row.organization_id,old_member.user_id,
      interview_row.id,1,'INTERVIEW_RELEASED',actor,'Interview reassigned',
      'wallet-reassign-release:'||interview_row.id||':'||reservation.wallet_version);
  END IF;
  UPDATE interviews SET responsible_member_user_id=target,updated_at=now() WHERE id=interview_row.id;
  IF reservation.status='RESERVED' THEN
    UPDATE credit_reservations SET member_user_id=target,wallet_version=wallet_version+1
      WHERE id=reservation.id RETURNING * INTO reservation;
    IF new_member.business_role='HR' THEN INSERT INTO hr_wallet_transactions(organization_id,
      member_user_id,interview_id,amount,kind,actor_user_id,reason,idempotency_key)
      VALUES(interview_row.organization_id,target,interview_row.id,-1,'INTERVIEW_RESERVED',actor,
      'Interview reassigned','wallet-reassign-reserve:'||interview_row.id||':'||reservation.wallet_version); END IF;
  END IF;
  INSERT INTO audit_logs(organization_id,actor_user_id,action,target_type,target_id,reason,
    previous_value,new_value) VALUES(interview_row.organization_id,actor,'INTERVIEW_REASSIGNED',
    'interview',interview_row.id::TEXT,'Interview responsibility changed',jsonb_build_object(
      'memberUserId',interview_row.responsible_member_user_id),jsonb_build_object('memberUserId',target));
  RETURN jsonb_build_object('updated',true);
EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('updated',false,
  'reason','INVALID_ASSIGNMENT');
END $$;

CREATE OR REPLACE FUNCTION authenti8_can_access_interview(actor UUID,target UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS(SELECT 1 FROM interviews interview JOIN organization_members member
    ON member.organization_id=interview.organization_id WHERE interview.id=target
      AND member.user_id=actor AND member.status='ACTIVE' AND (member.business_role IN ('OWNER','MANAGER')
        OR interview.responsible_member_user_id=actor))
$$;

REVOKE ALL ON FUNCTION authenti8_assign_interview_owner(),authenti8_wallet_reservation_transition(),
  authenti8_reassign_interview(JSONB),authenti8_can_access_interview(UUID,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION authenti8_reassign_interview(JSONB),
  authenti8_can_access_interview(UUID,UUID) TO service_role;
INSERT INTO schema_migrations(version) VALUES ('048_role_aware_interview_credits');
COMMIT;
