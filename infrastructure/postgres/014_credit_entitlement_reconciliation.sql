BEGIN;

ALTER TABLE credit_reservations ADD COLUMN IF NOT EXISTS release_reason TEXT
  CHECK (release_reason IN ('ENTITLEMENT', 'INELIGIBLE', 'MANUAL'));

CREATE OR REPLACE FUNCTION authenti8_mark_calendar_watch_error(input JSONB) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE calendar_sync_states sync SET last_error_code = input->>'errorCode', updated_at = now()
  WHERE sync.google_integration_id = (input->>'integrationId')::UUID
    AND EXISTS (SELECT 1 FROM google_integrations integration
      WHERE integration.id = sync.google_integration_id AND integration.status = 'ACTIVE'
        AND integration.connection_generation = (input->>'generation')::BIGINT)
  RETURNING jsonb_build_object('updated', true)
$$;

CREATE OR REPLACE FUNCTION authenti8_available_credits(org_id UUID) RETURNS INTEGER
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT GREATEST(authenti8_ledger_balance(org_id) - count(*)::INTEGER, 0)
  FROM credit_reservations WHERE organization_id = org_id AND status = 'RESERVED'
$$;

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
      AND interview.scheduled_end > now()
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
    ORDER BY interview.scheduled_start, interview.id
    LIMIT entitlement
  LOOP
    EXIT WHEN authenti8_available_credits(org_id) <= 0;
    PERFORM authenti8_reserve_credit(jsonb_build_object('interviewId', candidate.id));
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION authenti8_reconcile_all_credits(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE organization RECORD; examined INTEGER := 0;
BEGIN
  FOR organization IN SELECT id FROM organizations ORDER BY id LOOP
    PERFORM authenti8_reconcile_entitlement(organization.id);
    examined := examined + 1;
  END LOOP;
  RETURN jsonb_build_object('examined', examined);
END $$;

CREATE OR REPLACE FUNCTION authenti8_reconcile_user_credits(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID;
BEGIN
  org := authenti8_user_organization((input->>'userId')::UUID);
  IF org IS NULL THEN RETURN NULL; END IF;
  PERFORM authenti8_reconcile_entitlement(org);
  RETURN jsonb_build_object('reconciled', true);
END $$;

CREATE OR REPLACE FUNCTION authenti8_interview_credit_trigger() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'DETECTED' AND NEW.scheduled_end > now() THEN
    IF NOT EXISTS (SELECT 1 FROM credit_reservations
      WHERE interview_id = NEW.id AND status = 'RELEASED' AND release_reason = 'MANUAL') THEN
      PERFORM authenti8_reserve_credit(jsonb_build_object('interviewId', NEW.id));
    END IF;
  ELSIF NEW.status = 'DETECTED'
    OR NEW.status IN ('CANCELLED', 'EXCLUDED', 'SYNC_FAILED') THEN
    UPDATE credit_reservations SET status = 'RELEASED', released_at = now(),
      release_reason = 'INELIGIBLE'
    WHERE interview_id = NEW.id AND status = 'RESERVED';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION authenti8_entitlement_change_trigger() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org UUID;
BEGIN
  org := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  PERFORM authenti8_reconcile_entitlement(org);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS authenti8_interview_credit_insert ON interviews;
DROP TRIGGER IF EXISTS authenti8_interview_credit_update ON interviews;
DROP TRIGGER IF EXISTS authenti8_credit_entitlement_changed ON credit_transactions;
DROP TRIGGER IF EXISTS authenti8_subscription_entitlement_changed ON subscriptions;
CREATE TRIGGER authenti8_interview_credit_insert
AFTER INSERT ON interviews FOR EACH ROW EXECUTE FUNCTION authenti8_interview_credit_trigger();
CREATE TRIGGER authenti8_interview_credit_update
AFTER UPDATE OF status, scheduled_start, scheduled_end ON interviews
FOR EACH ROW EXECUTE FUNCTION authenti8_interview_credit_trigger();
CREATE CONSTRAINT TRIGGER authenti8_credit_entitlement_changed
AFTER INSERT OR UPDATE OR DELETE ON credit_transactions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION authenti8_entitlement_change_trigger();
CREATE CONSTRAINT TRIGGER authenti8_subscription_entitlement_changed
AFTER INSERT OR UPDATE OR DELETE ON subscriptions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION authenti8_entitlement_change_trigger();

REVOKE ALL ON FUNCTION authenti8_available_credits(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_mark_calendar_watch_error(JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_reconcile_entitlement(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_interview_credit_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_entitlement_change_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_reconcile_all_credits(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_reconcile_user_credits(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_reconcile_all_credits(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION authenti8_reconcile_user_credits(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION authenti8_mark_calendar_watch_error(JSONB) TO service_role;

SELECT authenti8_reconcile_all_credits('{}'::JSONB);
INSERT INTO schema_migrations(version) VALUES ('014_credit_entitlement_reconciliation');
COMMIT;
