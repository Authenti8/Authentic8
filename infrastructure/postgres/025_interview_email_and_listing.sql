BEGIN;

CREATE OR REPLACE FUNCTION authenti8_enqueue_email(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO auth_email_outbox(recipient, kind, encrypted_token,
    initialization_vector, authentication_tag, interview_id)
  VALUES (input->>'recipient', input->>'kind', input->>'encryptedToken',
    input->>'initializationVector', input->>'authenticationTag',
    NULLIF(input->>'interviewId', '')::UUID)
  RETURNING jsonb_build_object('created', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_claim_email(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE expired RECORD; result JSONB;
BEGIN
  FOR expired IN SELECT id, attempts FROM auth_email_outbox
    WHERE status = 'PROCESSING' AND lease_until <= now() AND attempts >= 5
    ORDER BY created_at LIMIT 10
  LOOP
    PERFORM authenti8_fail_email(jsonb_build_object('id', expired.id,
      'attempts', expired.attempts, 'error', 'Worker lease expired at retry limit'));
  END LOOP;
  WITH candidate AS (SELECT id FROM auth_email_outbox
    WHERE (status = 'PENDING' AND available_at <= now())
       OR (status = 'PROCESSING' AND lease_until <= now() AND attempts < 5)
    ORDER BY CASE WHEN kind = 'candidate_verification' THEN 0 ELSE 1 END,
      created_at FOR UPDATE SKIP LOCKED LIMIT 1), claimed AS (
    UPDATE auth_email_outbox outbox SET status = 'PROCESSING', attempts = attempts + 1,
      lease_until = now() + interval '30 seconds' FROM candidate
    WHERE outbox.id = candidate.id RETURNING outbox.*
  ) SELECT jsonb_build_object('id', id, 'recipient', recipient, 'kind', kind,
    'encryptedToken', encrypted_token, 'initializationVector', initialization_vector,
    'authenticationTag', authentication_tag, 'attempts', attempts,
    'interviewId', interview_id) INTO result FROM claimed;
  RETURN result;
END
$$;

CREATE OR REPLACE FUNCTION authenti8_renew_email(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE auth_email_outbox SET lease_until = now() + interval '30 seconds'
  WHERE id = (input->>'id')::UUID AND status = 'PROCESSING'
    AND attempts = (input->>'attempts')::INTEGER
  RETURNING jsonb_build_object('renewed', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_complete_email(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE target UUID; affected INTEGER := 0;
BEGIN
  SELECT interview_id INTO target FROM auth_email_outbox
  WHERE id = (input->>'id')::UUID AND status = 'PROCESSING'
    AND attempts = (input->>'attempts')::INTEGER;
  IF target IS NOT NULL THEN
    PERFORM id FROM interviews WHERE id = target FOR UPDATE;
  END IF;
  UPDATE auth_email_outbox SET status = 'SENT', sent_at = now(), lease_until = NULL,
    encrypted_token = NULL, initialization_vector = NULL, authentication_tag = NULL
  WHERE id = (input->>'id')::UUID AND status = 'PROCESSING'
    AND attempts = (input->>'attempts')::INTEGER RETURNING interview_id INTO target;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF target IS NOT NULL THEN
    UPDATE interviews SET verification_delivery_status = 'SENT' WHERE id = target;
  END IF;
  RETURN jsonb_build_object('completed', affected = 1);
END $$;

CREATE OR REPLACE FUNCTION authenti8_email_claim_is_deliverable(input JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE claimed auth_email_outbox; deliverable BOOLEAN; org UUID;
  interview_status TEXT; transitioned BOOLEAN := false; affected INTEGER := 0;
BEGIN
  SELECT * INTO claimed FROM auth_email_outbox
  WHERE id = (input->>'id')::UUID AND status = 'PROCESSING'
    AND attempts = (input->>'attempts')::INTEGER;
  IF claimed.id IS NULL THEN RETURN false; END IF;
  IF claimed.kind <> 'candidate_verification' THEN
    PERFORM id FROM auth_email_outbox WHERE id = claimed.id AND status = 'PROCESSING'
      AND attempts = claimed.attempts FOR UPDATE;
    RETURN FOUND;
  END IF;
  SELECT status, organization_id INTO interview_status, org FROM interviews
    WHERE id = claimed.interview_id FOR UPDATE;
  SELECT * INTO claimed FROM auth_email_outbox WHERE id = claimed.id AND status = 'PROCESSING'
    AND attempts = claimed.attempts FOR UPDATE;
  IF claimed.id IS NULL THEN RETURN false; END IF;
  SELECT interview_status = 'CONSENT_PENDING' AND EXISTS (SELECT 1
    FROM candidate_verification_tokens token WHERE token.interview_id = claimed.interview_id
      AND token.consumed_at IS NULL AND token.expires_at > now()) INTO deliverable;
  IF deliverable THEN RETURN true; END IF;
  IF interview_status IN ('DEVICE_CONNECTING', 'MONITORING_ACTIVE', 'MEETING_COMPLETED',
      'REPORT_PROCESSING', 'REPORT_READY', 'CONSENT_DECLINED') THEN
    UPDATE auth_email_outbox SET status = 'SENT', sent_at = COALESCE(sent_at, now()),
      lease_until = NULL, encrypted_token = NULL, initialization_vector = NULL,
      authentication_tag = NULL
      WHERE id = claimed.id AND status = 'PROCESSING' AND attempts = claimed.attempts;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected = 1 THEN UPDATE interviews SET verification_delivery_status = 'SENT'
      WHERE id = claimed.interview_id; END IF;
    RETURN false;
  END IF;
  UPDATE auth_email_outbox SET status = 'FAILED', lease_until = NULL,
    encrypted_token = NULL, initialization_vector = NULL, authentication_tag = NULL,
    last_error = 'Candidate verification is no longer deliverable'
    WHERE id = claimed.id AND status = 'PROCESSING' AND attempts = claimed.attempts;
  UPDATE candidate_verification_tokens SET consumed_at = COALESCE(consumed_at, now())
    WHERE interview_id = claimed.interview_id AND consumed_at IS NULL;
  transitioned := authenti8_transition_interview(claimed.interview_id,
    ARRAY['CONSENT_PENDING'], 'UNABLE_TO_VERIFY', 'VERIFICATION_EMAIL_EXPIRED');
  IF transitioned THEN
    UPDATE interviews SET verification_delivery_status = 'FAILED'
      WHERE id = claimed.interview_id;
    UPDATE credit_reservations SET status = 'RELEASED', released_at = now(),
      release_reason = 'INELIGIBLE'
      WHERE interview_id = claimed.interview_id AND status = 'RESERVED';
    UPDATE interviews SET protection_status = 'RELEASED'
      WHERE id = claimed.interview_id AND protection_status = 'RESERVED';
    INSERT INTO workspace_notifications(organization_id, interview_id, kind, message, idempotency_key)
    VALUES (org, claimed.interview_id, 'VERIFICATION_DELIVERY_FAILED',
      'Candidate verification email expired before delivery.',
      'candidate-email-undeliverable:' || claimed.interview_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION authenti8_fail_email(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE target UUID; terminal BOOLEAN; org UUID; transitioned BOOLEAN := false;
BEGIN
  SELECT interview_id INTO target FROM auth_email_outbox
  WHERE id = (input->>'id')::UUID AND status = 'PROCESSING'
    AND attempts = (input->>'attempts')::INTEGER;
  IF target IS NOT NULL THEN
    PERFORM id FROM interviews WHERE id = target FOR UPDATE;
  END IF;
  UPDATE auth_email_outbox SET status = CASE WHEN attempts >= 5 THEN 'FAILED' ELSE 'PENDING' END,
    available_at = now() + LEAST(300, 5 * power(2, attempts)) * interval '1 second',
    lease_until = NULL, encrypted_token = CASE WHEN attempts >= 5 THEN NULL ELSE encrypted_token END,
    initialization_vector = CASE WHEN attempts >= 5 THEN NULL ELSE initialization_vector END,
    authentication_tag = CASE WHEN attempts >= 5 THEN NULL ELSE authentication_tag END,
    last_error = left(input->>'error', 500)
  WHERE id = (input->>'id')::UUID AND status = 'PROCESSING'
    AND attempts = (input->>'attempts')::INTEGER
  RETURNING interview_id, status = 'FAILED' INTO target, terminal;
  IF target IS NOT NULL AND terminal THEN
    transitioned := authenti8_transition_interview(target, ARRAY['CONSENT_PENDING'],
      'UNABLE_TO_VERIFY', 'VERIFICATION_EMAIL_FAILED');
    IF transitioned THEN
      UPDATE interviews SET verification_delivery_status = 'FAILED', protection_status =
        CASE WHEN protection_status = 'RESERVED' THEN 'RELEASED' ELSE protection_status END
        WHERE id = target RETURNING organization_id INTO org;
      INSERT INTO workspace_notifications(organization_id, interview_id, kind, message, idempotency_key)
      VALUES (org, target, 'VERIFICATION_DELIVERY_FAILED',
        'Candidate verification email could not be delivered.',
        'candidate-email-failed:' || target) ON CONFLICT DO NOTHING;
      UPDATE credit_reservations SET status = 'RELEASED', released_at = now(),
        release_reason = 'INELIGIBLE' WHERE interview_id = target AND status = 'RESERVED';
    END IF;
  END IF;
  RETURN jsonb_build_object('failed', target IS NOT NULL,
    'terminal', COALESCE(terminal, false));
END $$;

CREATE OR REPLACE FUNCTION authenti8_list_interviews(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'title', title,
    'candidateEmail', candidate_email, 'scheduledStart', scheduled_start,
    'scheduledEnd', scheduled_end, 'status', status,
    'protectionStatus', protection_status, 'meetUrl', google_meet_url,
    'classificationReason', classification_reason,
    'consentStatus', consent_status, 'verificationDeliveryStatus', verification_delivery_status)
    ORDER BY scheduled_start), '[]'::jsonb)
  FROM interviews interview
  WHERE organization_id = authenti8_user_organization((input->>'userId')::UUID)
    AND ((scheduled_start >= now() - interval '30 days' AND status <> 'EXCLUDED')
      OR EXISTS (SELECT 1 FROM reports report WHERE report.interview_id = interview.id))
$$;

REVOKE ALL ON FUNCTION authenti8_enqueue_email(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_claim_email(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_renew_email(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_complete_email(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_email_claim_is_deliverable(JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_fail_email(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_list_interviews(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_enqueue_email(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION authenti8_claim_email(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION authenti8_renew_email(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION authenti8_complete_email(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION authenti8_email_claim_is_deliverable(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION authenti8_fail_email(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION authenti8_list_interviews(JSONB) TO service_role;

INSERT INTO schema_migrations(version) VALUES ('025_interview_email_and_listing')
ON CONFLICT (version) DO NOTHING;
COMMIT;
