BEGIN;

CREATE TABLE billing_webhook_inbox (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'DEAD_LETTER')),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  lock_token UUID,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

CREATE INDEX billing_webhook_inbox_due_idx
  ON billing_webhook_inbox(available_at, created_at)
  WHERE status IN ('PENDING', 'PROCESSING');

ALTER TABLE billing_webhook_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_webhook_inbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_webhook_inbox FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION authenti8_enqueue_billing_webhook(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inserted INTEGER;
BEGIN
  IF COALESCE(input->>'eventId', '') = '' OR COALESCE(input->>'eventType', '') = ''
    OR jsonb_typeof(input->'payload') <> 'object' THEN
    RAISE EXCEPTION 'Invalid billing webhook envelope' USING ERRCODE = '22023';
  END IF;
  INSERT INTO billing_webhook_inbox(provider, event_id, event_type, payload)
  VALUES ('DODO', input->>'eventId', input->>'eventType', input->'payload')
  ON CONFLICT (provider, event_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN jsonb_build_object('accepted', true, 'duplicate', inserted = 0);
END $$;

CREATE OR REPLACE FUNCTION authenti8_claim_billing_webhooks(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result JSONB;
BEGIN
  UPDATE billing_webhook_inbox SET status = 'DEAD_LETTER', locked_at = NULL,
    lock_token = NULL, last_error_code = COALESCE(last_error_code, 'WORKER_TIMEOUT'),
    updated_at = now()
  WHERE attempt_count >= 10 AND ((status = 'PENDING' AND available_at <= now())
    OR (status = 'PROCESSING' AND locked_at < now() - interval '5 minutes'));
  WITH due AS (
    SELECT provider, event_id FROM billing_webhook_inbox
    WHERE attempt_count < 10 AND ((status = 'PENDING' AND available_at <= now())
      OR (status = 'PROCESSING' AND locked_at < now() - interval '5 minutes'))
    ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT 10
  ), claimed AS (
    UPDATE billing_webhook_inbox inbox SET status = 'PROCESSING', locked_at = now(),
      lock_token = gen_random_uuid(), attempt_count = attempt_count + 1, updated_at = now()
    FROM due WHERE inbox.provider = due.provider AND inbox.event_id = due.event_id
    RETURNING inbox.event_id, inbox.payload, inbox.lock_token
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('eventId', event_id,
    'payload', payload, 'claimToken', lock_token)), '[]'::jsonb)
  INTO result FROM claimed;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION authenti8_reconcile_expired_credits(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE organization RECORD; examined INTEGER := 0;
BEGIN
  FOR organization IN
    SELECT DISTINCT reservation.organization_id FROM credit_reservations reservation
    JOIN interviews interview ON interview.id = reservation.interview_id
    WHERE reservation.status = 'RESERVED'
      AND interview.scheduled_end + interval '30 minutes' <= now()
    ORDER BY reservation.organization_id
  LOOP
    PERFORM authenti8_reconcile_entitlement(organization.organization_id);
    UPDATE interviews interview SET protection_status = 'RELEASED', updated_at = now()
    FROM credit_reservations reservation
    WHERE interview.id = reservation.interview_id
      AND interview.organization_id = organization.organization_id
      AND interview.scheduled_end + interval '30 minutes' <= now()
      AND reservation.status = 'RELEASED';
    examined := examined + 1;
  END LOOP;
  RETURN jsonb_build_object('examined', examined);
END $$;

CREATE OR REPLACE FUNCTION authenti8_complete_billing_webhook(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE updated INTEGER;
BEGIN
  IF (input->>'success')::BOOLEAN THEN
    UPDATE billing_webhook_inbox SET status = 'PROCESSED', locked_at = NULL,
      lock_token = NULL, last_error_code = NULL, updated_at = now()
    WHERE provider = 'DODO' AND event_id = input->>'eventId'
      AND status = 'PROCESSING' AND lock_token = (input->>'claimToken')::UUID;
  ELSE
    UPDATE billing_webhook_inbox SET
      status = CASE WHEN attempt_count >= 10 THEN 'DEAD_LETTER' ELSE 'PENDING' END,
      locked_at = NULL,
      lock_token = NULL,
      available_at = CASE WHEN attempt_count >= 10 THEN available_at
        ELSE now() + attempt_count * interval '1 minute' END,
      last_error_code = NULLIF(input->>'errorCode', ''), updated_at = now()
    WHERE provider = 'DODO' AND event_id = input->>'eventId'
      AND status = 'PROCESSING' AND lock_token = (input->>'claimToken')::UUID;
  END IF;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN jsonb_build_object('completed', updated = 1);
END $$;

REVOKE ALL ON FUNCTION authenti8_enqueue_billing_webhook(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_enqueue_billing_webhook(JSONB) TO service_role;
REVOKE ALL ON FUNCTION authenti8_claim_billing_webhooks(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_claim_billing_webhooks(JSONB) TO service_role;
REVOKE ALL ON FUNCTION authenti8_complete_billing_webhook(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_complete_billing_webhook(JSONB) TO service_role;
REVOKE ALL ON FUNCTION authenti8_reconcile_expired_credits(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_reconcile_expired_credits(JSONB) TO service_role;

INSERT INTO schema_migrations(version) VALUES ('019_durable_billing_webhooks');
COMMIT;
