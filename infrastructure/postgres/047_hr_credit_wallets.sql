BEGIN;

CREATE TABLE hr_wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  member_user_id UUID NOT NULL REFERENCES users(id),
  interview_id UUID REFERENCES interviews(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ALLOCATION_GRANTED','ALLOCATION_REDUCED',
    'INTERVIEW_RESERVED','INTERVIEW_CONSUMED','INTERVIEW_RELEASED','MEMBER_SUSPENDED',
    'ADMIN_CORRECTION')),
  actor_user_id UUID REFERENCES users(id),
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind IN ('ALLOCATION_GRANTED','INTERVIEW_RELEASED') AND amount > 0)
    OR (kind IN ('ALLOCATION_REDUCED','INTERVIEW_RESERVED','MEMBER_SUSPENDED') AND amount < 0)
    OR (kind IN ('INTERVIEW_CONSUMED','ADMIN_CORRECTION')))
);
CREATE INDEX hr_wallet_transactions_member_idx
  ON hr_wallet_transactions(organization_id,member_user_id,created_at DESC);
ALTER TABLE hr_wallet_transactions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION authenti8_wallet_balance(org UUID, member UUID) RETURNS INTEGER
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT COALESCE(sum(amount),0)::INTEGER FROM hr_wallet_transactions
  WHERE organization_id=org AND member_user_id=member
$$;

CREATE OR REPLACE FUNCTION authenti8_adjust_hr_wallet(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; org UUID; target UUID;
  quantity INTEGER := (input->>'quantity')::INTEGER; operation TEXT := input->>'operation';
  available INTEGER; allocated INTEGER; current_balance INTEGER; entry_kind TEXT; signed INTEGER;
  changed INTEGER; change_reason TEXT := trim(input->>'reason');
BEGIN
  SELECT organization_id INTO org FROM organization_members WHERE user_id=actor
    AND business_role IN ('OWNER','MANAGER') AND status='ACTIVE' ORDER BY created_at LIMIT 1;
  target := (input->>'memberUserId')::UUID;
  IF org IS NULL OR quantity NOT BETWEEN 1 AND 100000 OR operation NOT IN ('GRANT','REDUCE')
    OR length(change_reason) NOT BETWEEN 10 AND 500 OR NOT EXISTS (SELECT 1 FROM organization_members
      WHERE organization_id=org AND user_id=target AND business_role='HR' AND status='ACTIVE') THEN
    RETURN jsonb_build_object('updated',false,'reason','NOT_AUTHORIZED'); END IF;
  PERFORM id FROM organizations WHERE id=org FOR UPDATE;
  current_balance := authenti8_wallet_balance(org,target);
  IF operation='REDUCE' AND quantity > current_balance THEN
    RETURN jsonb_build_object('updated',false,'reason','INSUFFICIENT_WALLET'); END IF;
  IF operation='GRANT' THEN
    available := authenti8_available_credits(org);
    SELECT COALESCE(sum(GREATEST(authenti8_wallet_balance(org,user_id),0)),0)::INTEGER INTO allocated
      FROM organization_members WHERE organization_id=org AND business_role='HR' AND status='ACTIVE';
    IF quantity > available-allocated THEN
      RETURN jsonb_build_object('updated',false,'reason','INSUFFICIENT_ORGANIZATION_CREDITS'); END IF;
  END IF;
  entry_kind := CASE operation WHEN 'GRANT' THEN 'ALLOCATION_GRANTED' ELSE 'ALLOCATION_REDUCED' END;
  signed := CASE operation WHEN 'GRANT' THEN quantity ELSE -quantity END;
  INSERT INTO hr_wallet_transactions(organization_id,member_user_id,amount,kind,actor_user_id,
    reason,idempotency_key) VALUES(org,target,signed,entry_kind,actor,change_reason,input->>'idempotencyKey')
    ON CONFLICT(idempotency_key) DO NOTHING;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed=0 THEN RETURN jsonb_build_object('updated',true,'duplicate',true,
    'available',authenti8_wallet_balance(org,target)); END IF;
  INSERT INTO audit_logs(organization_id,actor_user_id,action,target_type,target_id,reason,new_value)
    VALUES(org,actor,'HR_WALLET_ADJUSTED','organization_member',target::TEXT,change_reason,
      jsonb_build_object('operation',operation,'quantity',quantity));
  RETURN jsonb_build_object('updated',true,'available',authenti8_wallet_balance(org,target));
EXCEPTION WHEN invalid_text_representation OR check_violation THEN
  RETURN jsonb_build_object('updated',false,'reason','INVALID_WALLET_CHANGE');
END $$;

CREATE OR REPLACE FUNCTION authenti8_wallets_overview(input JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; member organization_members;
BEGIN
  SELECT * INTO member FROM organization_members WHERE user_id=actor AND status='ACTIVE'
    ORDER BY created_at LIMIT 1;
  IF member.user_id IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('role',member.business_role,'wallets',COALESCE((SELECT jsonb_agg(
    jsonb_build_object('memberUserId',target.user_id,'name',account.full_name,'email',account.email,
      'available',authenti8_wallet_balance(member.organization_id,target.user_id),
      'reserved',COALESCE((SELECT -sum(amount) FROM hr_wallet_transactions tx WHERE
        tx.organization_id=member.organization_id AND tx.member_user_id=target.user_id
        AND tx.kind='INTERVIEW_RESERVED' AND NOT EXISTS (SELECT 1 FROM hr_wallet_transactions later
          WHERE later.interview_id=tx.interview_id AND later.member_user_id=tx.member_user_id
            AND later.kind IN ('INTERVIEW_CONSUMED','INTERVIEW_RELEASED'))),0),
      'consumed',COALESCE((SELECT count(*) FROM hr_wallet_transactions tx WHERE
        tx.organization_id=member.organization_id AND tx.member_user_id=target.user_id
        AND tx.kind='INTERVIEW_CONSUMED'),0)) ORDER BY account.full_name)
    FROM organization_members target JOIN users account ON account.id=target.user_id
    WHERE target.organization_id=member.organization_id AND target.business_role='HR'
      AND target.status<>'REMOVED' AND (member.business_role<>'HR' OR target.user_id=actor)), '[]'::JSONB));
END $$;

CREATE OR REPLACE FUNCTION authenti8_release_suspended_hr_wallet() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE balance INTEGER;
BEGIN
  IF NEW.business_role='HR' AND NEW.status<>'ACTIVE' AND OLD.status='ACTIVE' THEN
    balance := authenti8_wallet_balance(NEW.organization_id,NEW.user_id);
    IF balance>0 THEN INSERT INTO hr_wallet_transactions(organization_id,member_user_id,amount,kind,
      actor_user_id,reason,idempotency_key) VALUES(NEW.organization_id,NEW.user_id,-balance,
      'MEMBER_SUSPENDED',NULL,'Unused allocation returned after member access ended',
      'member-suspended:'||NEW.organization_id||':'||NEW.user_id||':'||NEW.updated_at); END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authenti8_hr_wallet_member_status AFTER UPDATE OF status ON organization_members
FOR EACH ROW EXECUTE FUNCTION authenti8_release_suspended_hr_wallet();

REVOKE ALL ON TABLE hr_wallet_transactions FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION authenti8_wallet_balance(UUID,UUID),authenti8_adjust_hr_wallet(JSONB),
  authenti8_wallets_overview(JSONB),authenti8_release_suspended_hr_wallet() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION authenti8_adjust_hr_wallet(JSONB),authenti8_wallets_overview(JSONB)
  TO service_role;
INSERT INTO schema_migrations(version) VALUES ('047_hr_credit_wallets');
COMMIT;
