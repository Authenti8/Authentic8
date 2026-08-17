BEGIN;

CREATE TABLE enterprise_agreements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL UNIQUE REFERENCES commercial_leads(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  state TEXT NOT NULL DEFAULT 'PROPOSAL' CHECK (state IN ('PROPOSAL','CONTRACT_PENDING',
    'PAYMENT_PENDING','ACTIVE','PAST_DUE','SUSPENDED','TERMINATED')),
  contract_value_minor BIGINT NOT NULL CHECK (contract_value_minor > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('MONTHLY','ANNUAL','ONE_TIME')),
  purchased_credits INTEGER NOT NULL CHECK (purchased_credits > 0),
  effective_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  payment_terms_days INTEGER NOT NULL CHECK (payment_terms_days BETWEEN 0 AND 365),
  sales_owner_user_id UUID NOT NULL REFERENCES users(id),
  signed_document_reference TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > effective_at)
);
CREATE TABLE enterprise_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id UUID NOT NULL REFERENCES enterprise_agreements(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL,
  provider_invoice_id TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  credits INTEGER NOT NULL CHECK (credits > 0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PAID','PAST_DUE','VOID','REFUNDED')),
  due_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_invoice_id)
);
CREATE TABLE enterprise_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id UUID NOT NULL REFERENCES enterprise_agreements(id),
  invoice_id UUID NOT NULL REFERENCES enterprise_invoices(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL,
  provider_payment_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  credits_posted INTEGER NOT NULL CHECK (credits_posted > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_payment_id), UNIQUE(provider,provider_event_id)
);
ALTER TABLE enterprise_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_payments ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION authenti8_upsert_enterprise_proposal(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; lead commercial_leads; agreement enterprise_agreements;
  org UUID := (input->>'organizationId')::UUID; amount BIGINT := (input->>'contractValueMinor')::BIGINT;
  credits INTEGER := (input->>'purchasedCredits')::INTEGER;
BEGIN
  SELECT * INTO lead FROM commercial_leads WHERE id=(input->>'leadId')::UUID FOR UPDATE;
  IF lead.id IS NULL OR lead.stage<>'WON' OR lead.converted_organization_id<>org OR NOT EXISTS(
    SELECT 1 FROM platform_staff staff WHERE staff.user_id=actor AND staff.status='ACTIVE'
      AND (staff.role='PLATFORM_FOUNDER' OR lead.assigned_to=actor)) THEN
    RETURN jsonb_build_object('updated',false,'reason','NOT_AUTHORIZED'); END IF;
  IF amount<=0 OR credits<=0 OR input->>'currency' !~ '^[A-Z]{3}$'
      OR input->>'billingInterval' NOT IN ('MONTHLY','ANNUAL','ONE_TIME') THEN
    RETURN jsonb_build_object('updated',false,'reason','INVALID_PROPOSAL'); END IF;
  INSERT INTO enterprise_agreements(lead_id,organization_id,contract_value_minor,currency,
    billing_interval,purchased_credits,effective_at,expires_at,payment_terms_days,
    sales_owner_user_id,signed_document_reference,created_by)
  VALUES(lead.id,org,amount,input->>'currency',input->>'billingInterval',credits,
    (input->>'effectiveAt')::TIMESTAMPTZ,NULLIF(input->>'expiresAt','')::TIMESTAMPTZ,
    (input->>'paymentTermsDays')::INTEGER,COALESCE(lead.assigned_to,actor),
    NULLIF(input->>'signedDocumentReference',''),actor)
  ON CONFLICT(lead_id) DO UPDATE SET contract_value_minor=EXCLUDED.contract_value_minor,
    currency=EXCLUDED.currency,billing_interval=EXCLUDED.billing_interval,
    purchased_credits=EXCLUDED.purchased_credits,effective_at=EXCLUDED.effective_at,
    expires_at=EXCLUDED.expires_at,payment_terms_days=EXCLUDED.payment_terms_days,
    signed_document_reference=EXCLUDED.signed_document_reference,updated_at=now()
  WHERE enterprise_agreements.state IN ('PROPOSAL','CONTRACT_PENDING') RETURNING * INTO agreement;
  IF agreement.id IS NULL THEN RETURN jsonb_build_object('updated',false,'reason','AGREEMENT_LOCKED'); END IF;
  INSERT INTO audit_logs(actor_user_id,action,target_type,target_id,reason,new_value)
    VALUES(actor,'ENTERPRISE_PROPOSAL_UPDATED','enterprise_agreement',agreement.id::TEXT,
      'Commercial proposal recorded',jsonb_build_object('organizationId',org,'amountMinor',amount,
      'currency',input->>'currency','credits',credits));
  RETURN jsonb_build_object('updated',true,'agreementId',agreement.id);
EXCEPTION WHEN invalid_text_representation OR check_violation THEN
  RETURN jsonb_build_object('updated',false,'reason','INVALID_PROPOSAL');
END $$;

CREATE OR REPLACE FUNCTION authenti8_issue_enterprise_invoice(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; agreement enterprise_agreements;
  invoice enterprise_invoices; inserted UUID;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM platform_staff WHERE user_id=actor
      AND role='PLATFORM_FOUNDER' AND status='ACTIVE') THEN
    RETURN jsonb_build_object('created',false,'reason','NOT_AUTHORIZED'); END IF;
  SELECT * INTO agreement FROM enterprise_agreements WHERE id=(input->>'agreementId')::UUID FOR UPDATE;
  IF agreement.id IS NULL OR agreement.state NOT IN ('PROPOSAL','CONTRACT_PENDING','PAYMENT_PENDING')
      OR NULLIF(trim(input->>'signedDocumentReference'),'') IS NULL THEN
    RETURN jsonb_build_object('created',false,'reason','INVALID_AGREEMENT'); END IF;
  INSERT INTO enterprise_invoices(agreement_id,organization_id,provider,provider_invoice_id,
    amount_minor,currency,credits,due_at) VALUES(agreement.id,agreement.organization_id,
    input->>'provider',input->>'providerInvoiceId',agreement.contract_value_minor,
    agreement.currency,agreement.purchased_credits,(input->>'dueAt')::TIMESTAMPTZ)
    ON CONFLICT(provider,provider_invoice_id) DO NOTHING RETURNING id INTO inserted;
  IF inserted IS NULL THEN
    SELECT * INTO invoice FROM enterprise_invoices WHERE provider=input->>'provider'
      AND provider_invoice_id=input->>'providerInvoiceId' FOR UPDATE;
    IF invoice.agreement_id<>agreement.id OR invoice.organization_id<>agreement.organization_id
        OR invoice.amount_minor<>agreement.contract_value_minor OR invoice.currency<>agreement.currency
        OR invoice.credits<>agreement.purchased_credits THEN
      RETURN jsonb_build_object('created',false,'reason','INVOICE_ID_CONFLICT'); END IF;
  ELSE SELECT * INTO invoice FROM enterprise_invoices WHERE id=inserted; END IF;
  UPDATE enterprise_agreements SET state='PAYMENT_PENDING',
    signed_document_reference=input->>'signedDocumentReference',updated_at=now() WHERE id=agreement.id;
  INSERT INTO audit_logs(actor_user_id,action,target_type,target_id,reason,new_value)
    VALUES(actor,'ENTERPRISE_INVOICE_ISSUED','enterprise_invoice',invoice.id::TEXT,
      'Signed contract invoiced',jsonb_build_object('agreementId',agreement.id));
  RETURN jsonb_build_object('created',true,'invoiceId',invoice.id);
EXCEPTION WHEN invalid_text_representation OR check_violation THEN
  RETURN jsonb_build_object('created',false,'reason','INVALID_INVOICE');
END $$;

CREATE OR REPLACE FUNCTION authenti8_apply_enterprise_payment(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE invoice enterprise_invoices; agreement enterprise_agreements; inserted UUID;
  prior enterprise_payments;
BEGIN
  SELECT * INTO prior FROM enterprise_payments WHERE provider=input->>'provider' AND
    (provider_event_id=input->>'providerEventId' OR provider_payment_id=input->>'providerPaymentId')
    FOR UPDATE;
  IF prior.id IS NOT NULL THEN
    IF prior.provider_event_id=input->>'providerEventId'
        AND prior.provider_payment_id=input->>'providerPaymentId'
        AND prior.amount_minor=(input->>'amountMinor')::BIGINT
        AND prior.currency=input->>'currency' AND prior.credits_posted=(input->>'credits')::INTEGER
        AND EXISTS(SELECT 1 FROM enterprise_invoices existing WHERE existing.id=prior.invoice_id
          AND existing.provider_invoice_id=input->>'providerInvoiceId') THEN
      RETURN jsonb_build_object('applied',true,'duplicate',true); END IF;
    RETURN jsonb_build_object('applied',false,'reason','PAYMENT_ID_CONFLICT');
  END IF;
  SELECT * INTO invoice FROM enterprise_invoices WHERE provider=input->>'provider'
    AND provider_invoice_id=input->>'providerInvoiceId' FOR UPDATE;
  IF invoice.id IS NULL OR invoice.status NOT IN ('OPEN','PAST_DUE')
      OR invoice.amount_minor<>(input->>'amountMinor')::BIGINT OR invoice.currency<>input->>'currency'
      OR invoice.credits<>(input->>'credits')::INTEGER THEN
    RETURN jsonb_build_object('applied',false,'reason','PAYMENT_MISMATCH'); END IF;
  SELECT * INTO agreement FROM enterprise_agreements WHERE id=invoice.agreement_id FOR UPDATE;
  INSERT INTO enterprise_payments(agreement_id,invoice_id,organization_id,provider,
    provider_payment_id,provider_event_id,amount_minor,currency,credits_posted)
    VALUES(agreement.id,invoice.id,invoice.organization_id,input->>'provider',
      input->>'providerPaymentId',input->>'providerEventId',(input->>'amountMinor')::BIGINT,
      input->>'currency',(input->>'credits')::INTEGER)
    ON CONFLICT(provider,provider_event_id) DO NOTHING RETURNING id INTO inserted;
  IF inserted IS NULL THEN RETURN jsonb_build_object('applied',true,'duplicate',true); END IF;
  UPDATE enterprise_invoices SET status='PAID',paid_at=now(),updated_at=now() WHERE id=invoice.id;
  UPDATE enterprise_agreements SET state='ACTIVE',updated_at=now() WHERE id=agreement.id;
  INSERT INTO subscriptions(organization_id,provider,provider_subscription_id,plan_key,status,
    current_period_start,current_period_end) VALUES(agreement.organization_id,input->>'provider',
    'enterprise:'||agreement.id,'ENTERPRISE','ACTIVE',agreement.effective_at,agreement.expires_at)
    ON CONFLICT(provider_subscription_id) DO UPDATE SET status='ACTIVE',updated_at=now();
  INSERT INTO credit_transactions(organization_id,amount,kind,reference_id,idempotency_key)
    VALUES(agreement.organization_id,invoice.credits,'EXTRA_PURCHASE',invoice.id::TEXT,
      'enterprise-payment:'||(input->>'provider')||':'||(input->>'providerEventId'))
      ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('applied',true,'credits',invoice.credits);
END $$;

CREATE OR REPLACE FUNCTION authenti8_enterprise_overview(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT CASE WHEN EXISTS(SELECT 1 FROM platform_staff WHERE user_id=(input->>'userId')::UUID
    AND status='ACTIVE') OR EXISTS(SELECT 1 FROM platform_administrators WHERE
      user_id=(input->>'userId')::UUID) THEN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',agreement.id,'leadId',agreement.lead_id,'organizationId',agreement.organization_id,
      'organizationName',organization.name,'state',agreement.state,
      'contractValueMinor',agreement.contract_value_minor,'currency',agreement.currency,
      'billingInterval',agreement.billing_interval,'purchasedCredits',agreement.purchased_credits,
      'signedDocumentReference',agreement.signed_document_reference,'invoiceTotalMinor',COALESCE((
        SELECT sum(amount_minor) FROM enterprise_invoices WHERE agreement_id=agreement.id),0),
      'paymentTotalMinor',COALESCE((SELECT sum(amount_minor) FROM enterprise_payments
        WHERE agreement_id=agreement.id),0)) ORDER BY agreement.updated_at DESC)
      FROM enterprise_agreements agreement JOIN organizations organization
        ON organization.id=agreement.organization_id WHERE agreement.sales_owner_user_id=
          (input->>'userId')::UUID OR EXISTS(SELECT 1 FROM platform_staff founder WHERE
            founder.user_id=(input->>'userId')::UUID AND founder.role='PLATFORM_FOUNDER'
            AND founder.status='ACTIVE') OR EXISTS(SELECT 1 FROM platform_administrators admin
              WHERE admin.user_id=(input->>'userId')::UUID)), '[]'::JSONB) ELSE NULL END
$$;

REVOKE ALL ON TABLE enterprise_agreements,enterprise_invoices,enterprise_payments
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION authenti8_upsert_enterprise_proposal(JSONB),
 authenti8_issue_enterprise_invoice(JSONB),authenti8_apply_enterprise_payment(JSONB),
 authenti8_enterprise_overview(JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION authenti8_upsert_enterprise_proposal(JSONB),
 authenti8_issue_enterprise_invoice(JSONB),authenti8_apply_enterprise_payment(JSONB),
 authenti8_enterprise_overview(JSONB) TO service_role;
INSERT INTO schema_migrations(version) VALUES ('049_enterprise_contracts');
COMMIT;
