BEGIN; ALTER TABLE interviews
  ADD COLUMN IF NOT EXISTS lifecycle_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS verification_delivery_status TEXT NOT NULL DEFAULT 'NOT_SCHEDULED' CHECK
    (verification_delivery_status IN ('NOT_SCHEDULED', 'SCHEDULED', 'QUEUED', 'SENT', 'FAILED'));
ALTER TABLE auth_email_outbox DROP CONSTRAINT IF EXISTS auth_email_outbox_kind_check; ALTER TABLE auth_email_outbox
  ADD CONSTRAINT auth_email_outbox_kind_check
    CHECK (kind IN ('verify', 'reset', 'candidate_verification')),
  ADD COLUMN IF NOT EXISTS interview_id UUID REFERENCES interviews(id) ON DELETE CASCADE;
CREATE TABLE interview_lifecycle_events (
  id BIGSERIAL PRIMARY KEY, interview_id UUID NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  from_status TEXT, to_status TEXT NOT NULL, reason TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB, idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
); CREATE INDEX interview_lifecycle_events_interview_idx ON interview_lifecycle_events(interview_id, created_at, id);
CREATE TABLE verification_delivery_jobs (
  interview_id UUID PRIMARY KEY REFERENCES interviews(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING' CHECK
    (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), available_at TIMESTAMPTZ NOT NULL,
  lease_until TIMESTAMPTZ, claim_token UUID, last_error TEXT, completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
); CREATE INDEX verification_delivery_jobs_claim_idx ON verification_delivery_jobs(status, available_at, scheduled_for);
CREATE TABLE candidate_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id UUID NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  candidate_email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ, decision TEXT
    CHECK (decision IN ('ACCEPTED', 'DECLINED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX candidate_verification_tokens_active_idx ON candidate_verification_tokens(interview_id) WHERE consumed_at IS NULL;
CREATE TABLE candidate_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), interview_id UUID NOT NULL
    REFERENCES interviews(id) ON DELETE CASCADE,
  verification_token_id UUID NOT NULL UNIQUE REFERENCES candidate_verification_tokens(id),
  verification_session_id UUID UNIQUE REFERENCES verification_sessions(id),
  candidate_email TEXT NOT NULL, consent_version TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('ACCEPTED', 'DECLINED')),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(), accepted_at TIMESTAMPTZ,
  ip_address TEXT, user_agent TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((decision = 'ACCEPTED' AND verification_session_id IS NOT NULL AND accepted_at IS NOT NULL)
    OR (decision = 'DECLINED' AND verification_session_id IS NULL AND accepted_at IS NULL))
);
CREATE TABLE workspace_notifications (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  interview_id UUID REFERENCES interviews(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, message TEXT NOT NULL, read_at TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
); CREATE INDEX workspace_notifications_org_idx ON workspace_notifications(organization_id, read_at, created_at DESC);
CREATE OR REPLACE FUNCTION authenti8_current_consent_version() RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$ SELECT '2026-08-09'::TEXT $$;
CREATE OR REPLACE FUNCTION authenti8_valid_interview_transition(old_status TEXT, new_status TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT old_status = new_status OR CASE old_status
    WHEN 'DETECTED' THEN new_status IN ('PROTECTED', 'NO_CREDITS',
      'SUBSCRIPTION_INACTIVE', 'CANCELLED', 'EXCLUDED', 'SYNC_FAILED')
    WHEN 'PROTECTED' THEN new_status IN ('VERIFICATION_SCHEDULED', 'NO_CREDITS',
      'SUBSCRIPTION_INACTIVE', 'CANCELLED', 'EXCLUDED')
    WHEN 'VERIFICATION_SCHEDULED' THEN new_status IN ('WAITING_FOR_CANDIDATE', 'NO_CREDITS',
      'SUBSCRIPTION_INACTIVE', 'CANCELLED', 'EXCLUDED', 'UNABLE_TO_VERIFY')
    WHEN 'WAITING_FOR_CANDIDATE' THEN new_status IN ('CONSENT_PENDING', 'DETECTED',
      'CANCELLED', 'EXCLUDED', 'UNABLE_TO_VERIFY')
    WHEN 'CONSENT_PENDING' THEN new_status IN ('DEVICE_CONNECTING', 'DETECTED',
      'CONSENT_DECLINED', 'CANCELLED', 'EXCLUDED', 'UNABLE_TO_VERIFY')
    WHEN 'DEVICE_CONNECTING' THEN new_status IN ('DETECTED', 'MONITORING_ACTIVE',
      'CANCELLED', 'UNABLE_TO_VERIFY')
    WHEN 'UNABLE_TO_VERIFY' THEN new_status IN ('DETECTED', 'CANCELLED', 'EXCLUDED')
    WHEN 'MONITORING_ACTIVE' THEN new_status IN ('MEETING_COMPLETED', 'MONITORING_INTERRUPTED',
      'CANCELLED')
    WHEN 'MEETING_COMPLETED' THEN new_status = 'REPORT_PROCESSING'
    WHEN 'REPORT_PROCESSING' THEN new_status IN ('REPORT_READY', 'FAILED')
    WHEN 'CANCELLED' THEN new_status IN ('DETECTED', 'EXCLUDED')
    WHEN 'EXCLUDED' THEN new_status IN ('DETECTED', 'CANCELLED')
    WHEN 'SYNC_FAILED' THEN new_status IN ('DETECTED', 'CANCELLED', 'EXCLUDED')
    WHEN 'NO_CREDITS' THEN new_status IN ('DETECTED', 'CANCELLED', 'EXCLUDED')
    WHEN 'SUBSCRIPTION_INACTIVE' THEN new_status IN ('DETECTED', 'CANCELLED', 'EXCLUDED')
    ELSE false END
$$;
CREATE OR REPLACE FUNCTION authenti8_guard_interview_transition() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status
    AND NOT authenti8_valid_interview_transition(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'invalid interview lifecycle transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status THEN NEW.lifecycle_updated_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION authenti8_record_interview_transition() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO interview_lifecycle_events(
      interview_id, from_status, to_status, reason, idempotency_key
    ) VALUES (NEW.id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END, NEW.status,
      COALESCE(NULLIF(current_setting('authenti8.transition_reason', true), ''),
        CASE WHEN TG_OP = 'INSERT' THEN 'CALENDAR_DETECTED' ELSE 'STATE_CHANGED' END),
      NEW.id::TEXT || ':' || NEW.status || ':' || NEW.lifecycle_updated_at::TEXT)
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS authenti8_interview_transition_guard ON interviews; CREATE TRIGGER authenti8_interview_transition_guard BEFORE UPDATE OF status ON interviews
  FOR EACH ROW EXECUTE FUNCTION authenti8_guard_interview_transition();
DROP TRIGGER IF EXISTS authenti8_interview_transition_audit ON interviews; CREATE TRIGGER authenti8_interview_transition_audit AFTER INSERT OR UPDATE OF status ON interviews
  FOR EACH ROW EXECUTE FUNCTION authenti8_record_interview_transition();
CREATE OR REPLACE FUNCTION authenti8_transition_interview(
  target UUID, expected TEXT[], destination TEXT, transition_reason TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed_count INTEGER;
BEGIN
  PERFORM set_config('authenti8.transition_reason', transition_reason, true);
  UPDATE interviews SET status = destination, updated_at = now()
  WHERE id = target AND status = ANY(expected);
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END $$;
CREATE OR REPLACE FUNCTION authenti8_expire_verification(target UUID, expected TEXT[], expiry_reason TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID;
BEGIN
  SELECT organization_id INTO org FROM interviews WHERE id = target;
  IF org IS NULL OR NOT authenti8_transition_interview(target, expected,
    'UNABLE_TO_VERIFY', expiry_reason) THEN RETURN false; END IF;
  UPDATE verification_delivery_jobs SET status = 'CANCELLED', lease_until = NULL,
    claim_token = NULL, updated_at = now() WHERE interview_id = target
    AND status IN ('PENDING', 'PROCESSING');
  UPDATE candidate_verification_tokens SET consumed_at = COALESCE(consumed_at, now())
    WHERE interview_id = target AND consumed_at IS NULL;
  UPDATE verification_sessions SET status = 'CANCELLED',
    monitoring_ended_at = COALESCE(monitoring_ended_at, now())
    WHERE interview_id = target AND monitoring_started_at IS NULL;
  DELETE FROM auth_email_outbox WHERE interview_id = target
    AND kind = 'candidate_verification' AND status IN ('PENDING', 'PROCESSING');
  UPDATE credit_reservations SET status = 'RELEASED', released_at = now(),
    release_reason = 'INELIGIBLE' WHERE interview_id = target AND status = 'RESERVED';
  UPDATE interviews SET verification_delivery_status = 'FAILED', protection_status = CASE
    WHEN protection_status = 'RESERVED' THEN 'RELEASED' ELSE protection_status END,
    updated_at = now() WHERE id = target;
  INSERT INTO workspace_notifications(organization_id, interview_id, kind, message, idempotency_key) VALUES (org, target,
    CASE WHEN expiry_reason = 'VERIFICATION_WINDOW_EXPIRED' THEN 'VERIFICATION_EXPIRED'
    ELSE 'VERIFICATION_UNAVAILABLE' END, CASE WHEN expiry_reason = 'VERIFICATION_WINDOW_EXPIRED' THEN
    'Candidate verification was not completed before the interview window closed.' ELSE 'Candidate verification is no longer eligible for this interview.' END,
    CASE WHEN expiry_reason = 'VERIFICATION_WINDOW_EXPIRED' THEN 'verification-expired:' ELSE 'verification-unavailable:' END || target) ON CONFLICT DO NOTHING;
  RETURN true; END $$;
CREATE OR REPLACE FUNCTION authenti8_consume_credit(input JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE reservation credit_reservations; interview_row interviews; org UUID; period_key TEXT; allowance_balance INTEGER; extra_balance INTEGER; transaction_kind TEXT;
BEGIN
  SELECT organization_id INTO org FROM interviews WHERE id = (input->>'interviewId')::UUID;
  IF org IS NULL THEN RETURN NULL; END IF;
  PERFORM id FROM organizations WHERE id = org FOR UPDATE;
  SELECT interview.* INTO interview_row FROM interviews interview WHERE interview.id = (input->>'interviewId')::UUID AND interview.organization_id = org FOR UPDATE;
  SELECT candidate.* INTO reservation FROM credit_reservations candidate WHERE candidate.interview_id = interview_row.id
    AND candidate.organization_id = interview_row.organization_id FOR UPDATE;
  IF reservation.id IS NULL THEN RETURN NULL; END IF;
  IF reservation.status = 'CONSUMED' THEN
    UPDATE interviews SET protection_status = 'CONSUMED' WHERE id = interview_row.id;
    RETURN jsonb_build_object('consumed', true); END IF;
  IF reservation.status = 'RELEASED' THEN
    UPDATE interviews SET protection_status = 'RELEASED' WHERE id = interview_row.id;
    RETURN jsonb_build_object('consumed', false, 'reason', 'RELEASED'); END IF;
  IF interview_row.status <> 'DEVICE_CONNECTING' THEN
    RETURN jsonb_build_object('consumed', false, 'reason', 'INTERVIEW_NOT_ELIGIBLE'); END IF;
  IF now() < interview_row.scheduled_start - interval '15 minutes' OR now() > interview_row.scheduled_end + interval '30 minutes' THEN
    UPDATE credit_reservations SET status = 'RELEASED', released_at = now(), release_reason =
      'INELIGIBLE' WHERE id = reservation.id AND status = 'RESERVED';
    UPDATE interviews SET protection_status = 'RELEASED', updated_at = now() WHERE id = interview_row.id;
    RETURN jsonb_build_object('consumed', false, 'reason', 'INTERVIEW_OUTSIDE_WINDOW');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subscriptions WHERE organization_id = interview_row.organization_id
    AND status IN ('ACTIVE', 'TRIALING')) THEN
    UPDATE interviews SET protection_status = 'UNPROTECTED_SUBSCRIPTION' WHERE id = interview_row.id;
    RETURN jsonb_build_object('consumed', false, 'reason', 'INACTIVE_SUBSCRIPTION');
  END IF;
  period_key := authenti8_period_key(interview_row.organization_id);
  SELECT COALESCE(sum(amount), 0) INTO allowance_balance FROM credit_transactions WHERE organization_id
    = interview_row.organization_id AND kind IN ('MONTHLY_ALLOWANCE', 'PLAN_UPGRADE',
      'ALLOWANCE_CONSUMED') AND reference_id = period_key;
  SELECT COALESCE(sum(amount), 0) INTO extra_balance FROM credit_transactions WHERE organization_id =
    interview_row.organization_id AND kind IN ('EXTRA_PURCHASE', 'EXTRA_CONSUMED', 'EXTRA_REVERSAL');
  IF allowance_balance <= 0 AND extra_balance <= 0 THEN
    UPDATE interviews SET protection_status = 'UNPROTECTED_NO_CREDITS' WHERE id = interview_row.id;
    RETURN jsonb_build_object('consumed', false, 'reason', 'NO_CREDITS'); END IF;
  PERFORM set_config('authenti8.transition_reason', 'MONITORING_STARTED', true);
  UPDATE interviews SET monitoring_started_at = COALESCE(monitoring_started_at, now()), status =
    'MONITORING_ACTIVE', protection_status = 'CONSUMED', updated_at = now() WHERE id = interview_row.id
    AND status = 'DEVICE_CONNECTING';
  transaction_kind := CASE WHEN allowance_balance > 0 THEN 'ALLOWANCE_CONSUMED'
    ELSE 'EXTRA_CONSUMED' END;
  UPDATE credit_reservations SET status = 'CONSUMED', consumed_at = now()
    WHERE id = reservation.id AND status = 'RESERVED';
  INSERT INTO credit_transactions(organization_id, amount, kind, reference_id, idempotency_key)
  VALUES (interview_row.organization_id, -1, transaction_kind,
    CASE WHEN transaction_kind = 'ALLOWANCE_CONSUMED' THEN period_key ELSE interview_row.id::TEXT END,
    'consume:' || interview_row.id) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('consumed', true); END $$;
CREATE OR REPLACE FUNCTION authenti8_orchestrate_interviews(input JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE item RECORD; protected_count INTEGER := 0; scheduled_count INTEGER := 0; BEGIN
  FOR item IN SELECT interview.id, interview.status FROM interviews interview
    WHERE (interview.status = 'VERIFICATION_SCHEDULED' AND interview.scheduled_end <= now()) OR
      (interview.status IN ('CONSENT_PENDING', 'DEVICE_CONNECTING')
        AND interview.scheduled_end + interval '30 minutes' <= now())
    ORDER BY interview.scheduled_end FOR UPDATE SKIP LOCKED LOOP
    PERFORM authenti8_expire_verification(item.id, ARRAY[item.status], 'VERIFICATION_WINDOW_EXPIRED');
  END LOOP;
  FOR item IN SELECT interview.id, interview.status, interview.scheduled_start,
      interview.protection_status, subscription.status AS subscription_status
    FROM interviews interview
    LEFT JOIN LATERAL (SELECT status FROM subscriptions candidate
      WHERE candidate.organization_id = interview.organization_id
      ORDER BY updated_at DESC LIMIT 1) subscription ON true
    WHERE interview.status IN ('DETECTED', 'PROTECTED', 'NO_CREDITS', 'SUBSCRIPTION_INACTIVE')
      AND interview.scheduled_end > now() ORDER BY interview.scheduled_start
  LOOP
    IF item.status = 'NO_CREDITS' AND item.subscription_status IN ('ACTIVE', 'TRIALING')
      AND authenti8_available_credits((SELECT organization_id FROM interviews WHERE id = item.id)) > 0 THEN
      PERFORM authenti8_transition_interview(item.id, ARRAY['NO_CREDITS'],
        'DETECTED', 'CREDITS_RESTORED');
      PERFORM authenti8_reserve_credit(jsonb_build_object('interviewId', item.id));
      CONTINUE;
    ELSIF item.status = 'SUBSCRIPTION_INACTIVE'
      AND item.subscription_status IN ('ACTIVE', 'TRIALING') THEN
      PERFORM authenti8_transition_interview(item.id, ARRAY['SUBSCRIPTION_INACTIVE'],
        'DETECTED', 'SUBSCRIPTION_RESTORED');
      PERFORM authenti8_reserve_credit(jsonb_build_object('interviewId', item.id));
      CONTINUE;
    ELSIF item.status IN ('NO_CREDITS', 'SUBSCRIPTION_INACTIVE') THEN
      CONTINUE;
    END IF;
    IF item.status = 'PROTECTED' AND item.subscription_status NOT IN ('ACTIVE', 'TRIALING') THEN
      PERFORM authenti8_transition_interview(item.id, ARRAY['PROTECTED'], 'SUBSCRIPTION_INACTIVE',
        'SUBSCRIPTION_INACTIVE'); CONTINUE;
    ELSIF item.status = 'PROTECTED' AND item.protection_status <> 'RESERVED' THEN
      PERFORM authenti8_transition_interview(item.id, ARRAY['PROTECTED'], 'NO_CREDITS',
        'NO_AVAILABLE_CREDIT'); CONTINUE;
    END IF;
    IF item.status = 'DETECTED' THEN
      IF item.subscription_status IS NULL
        OR item.subscription_status NOT IN ('ACTIVE', 'TRIALING') THEN
        PERFORM authenti8_transition_interview(item.id, ARRAY['DETECTED'],
          'SUBSCRIPTION_INACTIVE', 'SUBSCRIPTION_INACTIVE');
        CONTINUE;
      ELSIF item.protection_status NOT IN ('RESERVED', 'CONSUMED') THEN
        PERFORM authenti8_transition_interview(item.id, ARRAY['DETECTED'],
          'NO_CREDITS', 'NO_AVAILABLE_CREDIT');
        CONTINUE;
      END IF;
      IF authenti8_transition_interview(item.id, ARRAY['DETECTED'], 'PROTECTED',
        'CREDIT_RESERVED') THEN protected_count := protected_count + 1; END IF;
    END IF;
    IF item.scheduled_start <= now() + interval '7 days' AND
      authenti8_transition_interview(item.id, ARRAY['PROTECTED'],
        'VERIFICATION_SCHEDULED', 'VERIFICATION_WINDOW_SCHEDULED') THEN
      INSERT INTO verification_delivery_jobs(interview_id, scheduled_for, available_at)
      VALUES (item.id, item.scheduled_start - interval '1 minute',
        item.scheduled_start - interval '1 minute')
      ON CONFLICT (interview_id) DO UPDATE SET
        scheduled_for = EXCLUDED.scheduled_for, available_at = EXCLUDED.available_at,
        status = CASE WHEN verification_delivery_jobs.status = 'COMPLETED'
          THEN verification_delivery_jobs.status ELSE 'PENDING' END,
        updated_at = now();
      UPDATE interviews SET verification_delivery_status = 'SCHEDULED' WHERE id = item.id;
      scheduled_count := scheduled_count + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('protected', protected_count, 'scheduled', scheduled_count); END $$;
CREATE OR REPLACE FUNCTION authenti8_claim_verification_delivery(input JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE job verification_delivery_jobs; interview_row interviews; subscription_status TEXT; expired RECORD; candidate_id UUID;
BEGIN
  FOR expired IN SELECT interview_id, claim_token, attempts FROM verification_delivery_jobs WHERE
    status = 'PROCESSING' AND lease_until <= now() AND attempts >= 5 ORDER BY scheduled_for LIMIT 10 LOOP
    PERFORM authenti8_fail_verification_delivery(jsonb_build_object(
      'interviewId', expired.interview_id, 'claimToken', expired.claim_token,
      'attempts', expired.attempts, 'error', 'Worker lease expired at retry limit'));
  END LOOP;
  FOR candidate_id IN SELECT interview_id FROM verification_delivery_jobs WHERE
    ((status = 'PENDING' AND available_at <= now()) OR (status = 'PROCESSING'
      AND lease_until <= now())) AND attempts < 5 ORDER BY scheduled_for LIMIT 20
  LOOP SELECT * INTO interview_row FROM interviews WHERE id = candidate_id FOR UPDATE;
  SELECT * INTO job FROM verification_delivery_jobs WHERE interview_id = candidate_id AND
    ((status = 'PENDING' AND available_at <= now()) OR (status = 'PROCESSING'
      AND lease_until <= now())) AND attempts < 5 FOR UPDATE SKIP LOCKED;
  IF job.interview_id IS NULL THEN CONTINUE; END IF;
  SELECT status INTO subscription_status FROM subscriptions WHERE organization_id =
    interview_row.organization_id ORDER BY updated_at DESC LIMIT 1;
  IF interview_row.status <> 'VERIFICATION_SCHEDULED' THEN
    UPDATE verification_delivery_jobs SET status = 'CANCELLED', updated_at = now()
      WHERE interview_id = job.interview_id;
    RETURN jsonb_build_object('skipped', true);
  END IF;
  IF interview_row.scheduled_end <= now() THEN
    PERFORM authenti8_expire_verification(job.interview_id,
      ARRAY['VERIFICATION_SCHEDULED'], 'VERIFICATION_WINDOW_EXPIRED');
    RETURN jsonb_build_object('skipped', true);
  END IF;
  IF subscription_status IS NULL OR subscription_status NOT IN ('ACTIVE', 'TRIALING') THEN
    PERFORM authenti8_transition_interview(job.interview_id,
      ARRAY['VERIFICATION_SCHEDULED'], 'SUBSCRIPTION_INACTIVE', 'DELIVERY_REVALIDATION');
    UPDATE verification_delivery_jobs SET status = 'CANCELLED', updated_at = now()
      WHERE interview_id = job.interview_id;
    RETURN jsonb_build_object('skipped', true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM credit_reservations reservation
    WHERE reservation.interview_id = job.interview_id
      AND reservation.status IN ('RESERVED', 'CONSUMED')) THEN
    PERFORM authenti8_transition_interview(job.interview_id,
      ARRAY['VERIFICATION_SCHEDULED'], 'NO_CREDITS', 'DELIVERY_REVALIDATION');
    UPDATE verification_delivery_jobs SET status = 'CANCELLED', updated_at = now()
      WHERE interview_id = job.interview_id;
    RETURN jsonb_build_object('skipped', true);
  END IF;
  UPDATE verification_delivery_jobs SET status = 'PROCESSING', attempts = attempts + 1,
    claim_token = gen_random_uuid(), lease_until = now() + interval '45 seconds', updated_at = now()
  WHERE interview_id = job.interview_id RETURNING * INTO job;
  RETURN jsonb_build_object('interviewId', interview_row.id,
    'candidateEmail', interview_row.candidate_email, 'candidateName', interview_row.candidate_name,
    'title', interview_row.title, 'scheduledStart', interview_row.scheduled_start,
    'scheduledEnd', interview_row.scheduled_end, 'claimToken', job.claim_token,
    'attempts', job.attempts);
  END LOOP; RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION authenti8_complete_verification_delivery(input JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE target_id UUID := (input->>'interviewId')::UUID; token_id UUID; org UUID; interview_status TEXT; subscription_status TEXT; reservation_status TEXT; BEGIN
  SELECT organization_id INTO org FROM interviews WHERE id = target_id; IF org IS NULL THEN RETURN NULL; END IF;
  PERFORM id FROM organizations WHERE id = org FOR UPDATE;
  SELECT status INTO interview_status FROM interviews WHERE id = target_id FOR UPDATE;
  SELECT status INTO reservation_status FROM credit_reservations WHERE interview_id = target_id AND organization_id = org FOR UPDATE;
  SELECT status INTO subscription_status FROM subscriptions WHERE organization_id = org ORDER BY updated_at DESC LIMIT 1;
  IF NOT EXISTS (SELECT 1 FROM verification_delivery_jobs job WHERE job.interview_id = target_id
    AND status = 'PROCESSING' AND claim_token = (input->>'claimToken')::UUID
    AND attempts = (input->>'attempts')::INTEGER) THEN RETURN NULL; END IF;
  IF interview_status <> 'VERIFICATION_SCHEDULED' OR subscription_status IS NULL
    OR subscription_status NOT IN ('ACTIVE', 'TRIALING') OR reservation_status IS NULL
    OR reservation_status NOT IN ('RESERVED', 'CONSUMED') THEN
    PERFORM authenti8_expire_verification(target_id, ARRAY['VERIFICATION_SCHEDULED'], 'DELIVERY_REVALIDATION_FAILED');
    RETURN jsonb_build_object('skipped', true);
  END IF;
  UPDATE candidate_verification_tokens SET consumed_at = now() WHERE candidate_verification_tokens.interview_id = target_id AND consumed_at IS NULL;
  INSERT INTO candidate_verification_tokens(interview_id, candidate_email, token_hash, expires_at)
  SELECT id, candidate_email, input->>'tokenHash', LEAST(scheduled_end + interval '30 minutes', now() + interval '48 hours') FROM interviews WHERE id = target_id
  RETURNING id INTO token_id;
  IF NULLIF(input->>'encryptedToken', '') IS NOT NULL THEN
    INSERT INTO auth_email_outbox(recipient, kind, encrypted_token, initialization_vector, authentication_tag, interview_id)
    SELECT candidate_email, 'candidate_verification', input->>'encryptedToken', input->>'initializationVector', input->>'authenticationTag', id
    FROM interviews WHERE id = target_id;
  END IF;
  PERFORM authenti8_transition_interview(target_id, ARRAY['VERIFICATION_SCHEDULED'], 'WAITING_FOR_CANDIDATE', 'VERIFICATION_EMAIL_QUEUED');
  PERFORM authenti8_transition_interview(target_id, ARRAY['WAITING_FOR_CANDIDATE'], 'CONSENT_PENDING', 'AWAITING_CANDIDATE_CONSENT');
  UPDATE interviews SET verification_delivery_status = CASE
    WHEN NULLIF(input->>'encryptedToken', '') IS NULL THEN 'SENT' ELSE 'QUEUED' END
    WHERE id = target_id;
  UPDATE verification_delivery_jobs SET status = 'COMPLETED', completed_at = now(), lease_until = NULL, updated_at = now()
    WHERE verification_delivery_jobs.interview_id = target_id;
  RETURN jsonb_build_object('completed', true, 'tokenId', token_id); END $$;
CREATE OR REPLACE FUNCTION authenti8_fail_verification_delivery(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE terminal BOOLEAN; org UUID;
BEGIN
  PERFORM id FROM interviews WHERE id = (input->>'interviewId')::UUID FOR UPDATE;
  UPDATE verification_delivery_jobs SET
    status = CASE WHEN attempts >= 5 THEN 'FAILED' ELSE 'PENDING' END,
    available_at = now() + LEAST(300, 5 * power(2, attempts)) * interval '1 second',
    lease_until = NULL, last_error = left(input->>'error', 500), updated_at = now()
  WHERE interview_id = (input->>'interviewId')::UUID AND status = 'PROCESSING'
    AND claim_token = (input->>'claimToken')::UUID
    AND attempts = (input->>'attempts')::INTEGER
  RETURNING status = 'FAILED' INTO terminal;
  IF terminal THEN
    UPDATE interviews SET verification_delivery_status = 'FAILED'
      WHERE id = (input->>'interviewId')::UUID RETURNING organization_id INTO org;
    PERFORM authenti8_transition_interview((input->>'interviewId')::UUID,
      ARRAY['VERIFICATION_SCHEDULED'], 'UNABLE_TO_VERIFY', 'VERIFICATION_DELIVERY_FAILED');
    UPDATE credit_reservations SET status = 'RELEASED', released_at = now(),
      release_reason = 'INELIGIBLE'
      WHERE interview_id = (input->>'interviewId')::UUID AND status = 'RESERVED';
    UPDATE interviews SET protection_status = 'RELEASED'
      WHERE id = (input->>'interviewId')::UUID;
    INSERT INTO workspace_notifications(organization_id, interview_id, kind, message, idempotency_key)
    VALUES (org, (input->>'interviewId')::UUID, 'VERIFICATION_DELIVERY_FAILED',
      'Candidate verification email could not be delivered.',
      'verification-delivery-failed:' || (input->>'interviewId')) ON CONFLICT DO NOTHING;
  END IF;
  RETURN jsonb_build_object('failed', true, 'terminal', COALESCE(terminal, false));
END $$;
CREATE OR REPLACE FUNCTION authenti8_candidate_verification(input JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE token candidate_verification_tokens; interview_row interviews; organization_name TEXT;
BEGIN
  SELECT * INTO token FROM candidate_verification_tokens
    WHERE token_hash = input->>'tokenHash';
  IF token.id IS NULL THEN RETURN jsonb_build_object('valid', false, 'reason', 'NOT_FOUND'); END IF;
  IF token.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'ALREADY_USED');
  END IF;
  IF token.expires_at <= now() THEN RETURN jsonb_build_object('valid', false, 'reason', 'EXPIRED'); END IF;
  SELECT * INTO interview_row FROM interviews WHERE id = token.interview_id;
  IF interview_row.status <> 'CONSENT_PENDING' OR NOT EXISTS (SELECT 1 FROM credit_reservations WHERE interview_id = interview_row.id AND organization_id = interview_row.organization_id AND status = 'RESERVED') OR NOT EXISTS (SELECT 1 FROM subscriptions WHERE organization_id = interview_row.organization_id AND status IN ('ACTIVE', 'TRIALING')) THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'INTERVIEW_UNAVAILABLE'); END IF;
  SELECT name INTO organization_name FROM organizations WHERE id = interview_row.organization_id;
  RETURN jsonb_build_object('valid', true, 'organizationName', organization_name,
    'interviewTitle', interview_row.title, 'candidateName', interview_row.candidate_name,
    'candidateEmail', token.candidate_email, 'scheduledStart', interview_row.scheduled_start,
    'scheduledEnd', interview_row.scheduled_end, 'expiresAt', token.expires_at,
    'consentVersion', authenti8_current_consent_version());
END $$;
CREATE OR REPLACE FUNCTION authenti8_record_candidate_consent(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE token candidate_verification_tokens; interview_row interviews; reservation credit_reservations; session_id UUID; accepted BOOLEAN := input->>'decision' = 'ACCEPTED';
BEGIN
  IF input->>'decision' NOT IN ('ACCEPTED', 'DECLINED') THEN
    RAISE EXCEPTION 'invalid consent decision' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO token FROM candidate_verification_tokens WHERE token_hash = input->>'tokenHash';
  IF token.id IS NULL THEN RETURN jsonb_build_object('accepted', false, 'reason', 'TOKEN_UNAVAILABLE'); END IF;
  SELECT * INTO interview_row FROM interviews WHERE id = token.interview_id FOR UPDATE;
  IF interview_row.id IS NULL THEN RETURN jsonb_build_object('accepted', false, 'reason', 'INTERVIEW_UNAVAILABLE'); END IF;
  SELECT * INTO token FROM candidate_verification_tokens WHERE id = token.id AND interview_id = interview_row.id FOR UPDATE;
  IF token.id IS NULL THEN RETURN jsonb_build_object('accepted', false, 'reason', 'TOKEN_UNAVAILABLE'); END IF;
  IF token.consumed_at IS NOT NULL THEN
    IF token.decision IS DISTINCT FROM input->>'decision' THEN
      RETURN jsonb_build_object('accepted', false, 'reason', 'CONSENT_DECISION_CONFLICT'); END IF;
    IF token.decision = 'DECLINED' THEN RETURN jsonb_build_object(
      'accepted', false, 'declined', true); END IF;
    SELECT consent.verification_session_id INTO session_id FROM candidate_consents consent JOIN
      verification_sessions session ON session.id = consent.verification_session_id JOIN interviews
      interview ON interview.id = consent.interview_id
      WHERE consent.verification_token_id = token.id AND consent.decision = 'ACCEPTED'
        AND session.status <> 'CANCELLED' AND interview.status IN ('DEVICE_CONNECTING',
          'MONITORING_ACTIVE', 'MEETING_COMPLETED', 'REPORT_PROCESSING', 'REPORT_READY');
    IF session_id IS NULL THEN RETURN jsonb_build_object(
      'accepted', false, 'reason', 'INTERVIEW_UNAVAILABLE'); END IF;
    RETURN jsonb_build_object('accepted', true, 'verificationSessionId', session_id);
  END IF;
  IF token.expires_at <= now() THEN RETURN jsonb_build_object(
    'accepted', false, 'reason', 'TOKEN_UNAVAILABLE'); END IF;
  IF interview_row.status <> 'CONSENT_PENDING' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'INTERVIEW_UNAVAILABLE');
  END IF;
  IF input->>'consentVersion' IS DISTINCT FROM authenti8_current_consent_version() THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'CONSENT_VERSION_CHANGED');
  END IF;
  SELECT candidate.* INTO reservation FROM credit_reservations candidate WHERE candidate.interview_id = interview_row.id AND candidate.organization_id = interview_row.organization_id FOR UPDATE; IF reservation.id IS NULL OR reservation.status <> 'RESERVED' OR NOT EXISTS (SELECT 1 FROM subscriptions WHERE organization_id = interview_row.organization_id AND status IN ('ACTIVE', 'TRIALING')) THEN RETURN jsonb_build_object('accepted', false, 'reason', 'INTERVIEW_UNAVAILABLE'); END IF;
  UPDATE candidate_verification_tokens SET consumed_at = now(), decision = input->>'decision'
    WHERE id = token.id;
  IF NOT accepted THEN
    INSERT INTO candidate_consents(interview_id, verification_token_id, candidate_email,
      consent_version, decision, ip_address, user_agent) VALUES (interview_row.id, token.id,
      token.candidate_email, input->>'consentVersion', 'DECLINED',
      NULLIF(input->>'ipAddress', ''), left(COALESCE(input->>'userAgent', ''), 500));
    UPDATE interviews SET consent_status = 'DECLINED', updated_at = now()
      WHERE id = interview_row.id;
    PERFORM authenti8_transition_interview(interview_row.id, ARRAY['CONSENT_PENDING'],
      'CONSENT_DECLINED', 'CANDIDATE_DECLINED');
    UPDATE credit_reservations SET status = 'RELEASED', released_at = now(),
      release_reason = 'INELIGIBLE' WHERE interview_id = interview_row.id AND status = 'RESERVED';
    UPDATE interviews SET protection_status = 'RELEASED' WHERE id = interview_row.id;
    INSERT INTO workspace_notifications(organization_id, interview_id, kind, message, idempotency_key)
    VALUES (interview_row.organization_id, interview_row.id, 'CONSENT_DECLINED',
      'The candidate declined interview verification.',
      'consent-declined:' || interview_row.id) ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('accepted', false, 'declined', true);
  END IF;
  INSERT INTO verification_sessions(interview_id, candidate_email, status, consent_version,
    consented_at, eligible_start, eligible_end)
  VALUES (interview_row.id, token.candidate_email, 'CONSENTED',
    input->>'consentVersion', now(),
    interview_row.scheduled_start - interval '15 minutes',
    interview_row.scheduled_end + interval '30 minutes') RETURNING id INTO session_id;
  INSERT INTO candidate_consents(interview_id, verification_token_id, verification_session_id,
    candidate_email, consent_version, decision, accepted_at, ip_address, user_agent)
  VALUES (interview_row.id, token.id, session_id, token.candidate_email,
    input->>'consentVersion', 'ACCEPTED', now(),
    NULLIF(input->>'ipAddress', ''), left(COALESCE(input->>'userAgent', ''), 500));
  UPDATE interviews SET consent_status = 'ACCEPTED', updated_at = now()
    WHERE id = interview_row.id;
  PERFORM authenti8_transition_interview(interview_row.id, ARRAY['CONSENT_PENDING'],
    'DEVICE_CONNECTING', 'CANDIDATE_CONSENTED');
  RETURN jsonb_build_object('accepted', true, 'verificationSessionId', session_id);
END $$;
ALTER TABLE interview_lifecycle_events ENABLE ROW LEVEL SECURITY; ALTER TABLE verification_delivery_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_verification_tokens ENABLE ROW LEVEL SECURITY; ALTER TABLE candidate_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON interview_lifecycle_events, verification_delivery_jobs,
  candidate_verification_tokens, candidate_consents, workspace_notifications
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_valid_interview_transition(TEXT, TEXT),
  authenti8_current_consent_version(), authenti8_guard_interview_transition(), authenti8_record_interview_transition(),
  authenti8_transition_interview(UUID, TEXT[], TEXT, TEXT),
  authenti8_expire_verification(UUID, TEXT[], TEXT), authenti8_orchestrate_interviews(JSONB),
  authenti8_claim_verification_delivery(JSONB), authenti8_complete_verification_delivery(JSONB),
  authenti8_fail_verification_delivery(JSONB), authenti8_candidate_verification(JSONB), authenti8_record_candidate_consent(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_orchestrate_interviews(JSONB),
  authenti8_claim_verification_delivery(JSONB), authenti8_complete_verification_delivery(JSONB),
  authenti8_fail_verification_delivery(JSONB), authenti8_candidate_verification(JSONB), authenti8_record_candidate_consent(JSONB) TO service_role;
INSERT INTO schema_migrations(version) VALUES ('022_interview_lifecycle_and_consent') ON CONFLICT DO NOTHING; COMMIT;
