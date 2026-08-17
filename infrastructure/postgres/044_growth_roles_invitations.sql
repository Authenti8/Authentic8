BEGIN;

CREATE TABLE commercial_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_type TEXT NOT NULL CHECK (lead_type IN ('DEMO_REQUEST', 'WAITLIST')),
  full_name TEXT NOT NULL CHECK (length(full_name) BETWEEN 2 AND 100),
  email TEXT NOT NULL,
  normalized_email TEXT NOT NULL,
  company_name TEXT NOT NULL CHECK (length(company_name) BETWEEN 2 AND 160),
  stage TEXT NOT NULL DEFAULT 'NEW' CHECK (stage IN ('NEW', 'CONTACTED', 'QUALIFIED',
    'DEMO_SCHEDULED', 'PROPOSAL_SENT', 'WON', 'LOST')),
  assigned_to UUID REFERENCES users(id),
  follow_up_owner UUID REFERENCES users(id),
  follow_up_due_at TIMESTAMPTZ,
  follow_up_reminder_at TIMESTAMPTZ,
  follow_up_reminded_at TIMESTAMPTZ,
  follow_up_completed_at TIMESTAMPTZ,
  follow_up_version INTEGER NOT NULL DEFAULT 0 CHECK (follow_up_version >= 0),
  source_path TEXT,
  referrer TEXT,
  attribution JSONB NOT NULL DEFAULT '{}'::JSONB,
  submission_count INTEGER NOT NULL DEFAULT 1 CHECK (submission_count > 0),
  last_submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  converted_organization_id UUID REFERENCES organizations(id),
  retention_due_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 months',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lead_type, normalized_email, company_name)
);
CREATE INDEX commercial_leads_pipeline_idx ON commercial_leads(stage, updated_at DESC);
ALTER TABLE commercial_leads ENABLE ROW LEVEL SECURITY;

CREATE TABLE commercial_lead_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES commercial_leads(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id),
  activity_type TEXT NOT NULL CHECK (activity_type IN
    ('SUBMITTED', 'STAGE_CHANGED', 'ASSIGNED', 'NOTE_ADDED', 'CONVERTED',
      'FOLLOW_UP_SCHEDULED', 'FOLLOW_UP_COMPLETED')),
  detail JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commercial_lead_activities_lead_idx
  ON commercial_lead_activities(lead_id, created_at DESC);
ALTER TABLE commercial_lead_activities ENABLE ROW LEVEL SECURITY;

CREATE TABLE commercial_email_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES commercial_leads(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('LEAD_CONFIRMATION', 'SALES_NOTIFICATION',
    'FOLLOW_UP_REMINDER')),
  deduplication_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (deduplication_key)
);
CREATE INDEX commercial_email_delivery_idx
  ON commercial_email_outbox(status, available_at, created_at);
ALTER TABLE commercial_email_outbox ENABLE ROW LEVEL SECURITY;

CREATE TABLE platform_staff (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('PLATFORM_FOUNDER', 'PLATFORM_SALES')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REMOVED')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE platform_staff ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_members
  ADD COLUMN business_role TEXT CHECK (business_role IN ('OWNER', 'MANAGER', 'HR')),
  ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REMOVED')),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE organization_members SET business_role = CASE role
  WHEN 'OWNER' THEN 'OWNER' WHEN 'ADMIN' THEN 'MANAGER' ELSE 'HR' END
WHERE business_role IS NULL;
ALTER TABLE organization_members ALTER COLUMN business_role SET NOT NULL;

CREATE OR REPLACE FUNCTION authenti8_set_business_role() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.business_role := COALESCE(NEW.business_role, CASE NEW.role
    WHEN 'OWNER' THEN 'OWNER' WHEN 'ADMIN' THEN 'MANAGER' ELSE 'HR' END);
  RETURN NEW;
END $$;
CREATE TRIGGER authenti8_business_role_before_insert BEFORE INSERT ON organization_members
FOR EACH ROW EXECUTE FUNCTION authenti8_set_business_role();

CREATE TABLE organization_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  normalized_email TEXT NOT NULL,
  invited_email TEXT NOT NULL,
  business_role TEXT NOT NULL CHECK (business_role IN ('MANAGER', 'HR')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by UUID NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_by UUID REFERENCES users(id),
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX organization_invitations_pending_idx
  ON organization_invitations(organization_id, normalized_email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY;

ALTER TABLE auth_email_outbox DROP CONSTRAINT auth_email_outbox_kind_check;
ALTER TABLE auth_email_outbox ADD CONSTRAINT auth_email_outbox_kind_check
  CHECK (kind IN ('verify', 'reset', 'candidate_verification', 'organization_invitation'));

CREATE OR REPLACE FUNCTION authenti8_submit_commercial_lead(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE lead commercial_leads; normalized TEXT := lower(trim(input->>'email'));
  company TEXT := trim(input->>'companyName'); lead_kind TEXT := input->>'leadType';
BEGIN
  IF lead_kind NOT IN ('DEMO_REQUEST', 'WAITLIST')
      OR normalized !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      OR length(normalized) > 320 OR length(trim(input->>'fullName')) NOT BETWEEN 2 AND 100
      OR length(company) NOT BETWEEN 2 AND 160 THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'INVALID_LEAD'); END IF;
  INSERT INTO commercial_leads(lead_type, full_name, email, normalized_email, company_name,
    source_path, referrer, attribution)
  VALUES (lead_kind, trim(input->>'fullName'), normalized, normalized, company,
    left(NULLIF(input->>'sourcePath', ''), 300), left(NULLIF(input->>'referrer', ''), 500),
    COALESCE(input->'attribution', '{}'::JSONB))
  ON CONFLICT (lead_type, normalized_email, company_name) DO UPDATE SET
    full_name = EXCLUDED.full_name, email = EXCLUDED.email,
    source_path = COALESCE(EXCLUDED.source_path, commercial_leads.source_path),
    referrer = COALESCE(EXCLUDED.referrer, commercial_leads.referrer),
    attribution = commercial_leads.attribution || EXCLUDED.attribution,
    submission_count = commercial_leads.submission_count + 1,
    last_submitted_at = now(), updated_at = now()
  RETURNING * INTO lead;
  INSERT INTO commercial_lead_activities(lead_id, activity_type, detail)
    VALUES (lead.id, 'SUBMITTED', jsonb_build_object('leadType', lead_kind));
  INSERT INTO commercial_email_outbox(lead_id, recipient, kind, deduplication_key)
    VALUES (lead.id, normalized, 'LEAD_CONFIRMATION', 'confirmation:' || lead.id) ON CONFLICT DO NOTHING;
  IF NULLIF(input->>'salesNotificationEmail', '') IS NOT NULL THEN
    INSERT INTO commercial_email_outbox(lead_id, recipient, kind, deduplication_key)
      VALUES (lead.id, lower(input->>'salesNotificationEmail'), 'SALES_NOTIFICATION',
        'sales:' || lead.id)
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN jsonb_build_object('accepted', true);
END $$;

CREATE OR REPLACE FUNCTION authenti8_claim_commercial_email(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE claimed commercial_email_outbox;
BEGIN
  UPDATE commercial_email_outbox SET status = 'PENDING', lease_until = NULL
    WHERE status = 'PROCESSING' AND lease_until <= now();
  SELECT * INTO claimed FROM commercial_email_outbox WHERE status = 'PENDING'
    AND available_at <= now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF claimed.id IS NULL THEN RETURN NULL; END IF;
  UPDATE commercial_email_outbox SET status = 'PROCESSING', attempts = attempts + 1,
    lease_until = now() + interval '30 seconds' WHERE id = claimed.id RETURNING * INTO claimed;
  RETURN (SELECT jsonb_build_object('id', claimed.id, 'attempts', claimed.attempts,
    'recipient', claimed.recipient, 'kind', claimed.kind, 'leadType', lead.lead_type,
    'fullName', lead.full_name, 'email', lead.email, 'companyName', lead.company_name)
    FROM commercial_leads lead WHERE lead.id = claimed.lead_id);
END $$;

CREATE OR REPLACE FUNCTION authenti8_complete_commercial_email(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed INTEGER;
BEGIN
  UPDATE commercial_email_outbox SET status = 'SENT', sent_at = now(), lease_until = NULL
    WHERE id = (input->>'id')::UUID AND status = 'PROCESSING'
      AND attempts = (input->>'attempts')::INTEGER;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN jsonb_build_object('completed', changed = 1);
EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('completed', false);
END $$;

CREATE OR REPLACE FUNCTION authenti8_fail_commercial_email(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed INTEGER;
BEGIN
  UPDATE commercial_email_outbox SET status = CASE WHEN attempts >= 5 THEN 'FAILED'
      ELSE 'PENDING' END, available_at = now() + LEAST(300, 5 * power(2, attempts))
      * interval '1 second', lease_until = NULL, last_error = left(input->>'error', 500)
    WHERE id = (input->>'id')::UUID AND status = 'PROCESSING'
      AND attempts = (input->>'attempts')::INTEGER;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN jsonb_build_object('updated', changed = 1);
EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('updated', false);
END $$;

CREATE OR REPLACE FUNCTION authenti8_commercial_overview(input JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; staff platform_staff;
  page_size INTEGER := LEAST(GREATEST(COALESCE((input->>'limit')::INTEGER, 25), 1), 100);
BEGIN
  SELECT * INTO staff FROM platform_staff WHERE user_id = actor AND status = 'ACTIVE';
  IF staff.user_id IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('role', staff.role,
    'staff', CASE WHEN staff.role = 'PLATFORM_FOUNDER' THEN COALESCE((SELECT jsonb_agg(
      jsonb_build_object('userId', member.user_id, 'name', account.full_name,
        'email', account.email, 'role', member.role, 'status', member.status)
      ORDER BY member.created_at) FROM platform_staff member JOIN users account
      ON account.id = member.user_id), '[]'::JSONB) ELSE '[]'::JSONB END,
    'leads', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', lead.id,
      'leadType', lead.lead_type, 'fullName', lead.full_name, 'email', lead.email,
      'companyName', lead.company_name, 'stage', lead.stage, 'assignedTo', lead.assigned_to,
      'convertedOrganizationId', lead.converted_organization_id,
      'followUpOwner', lead.follow_up_owner, 'followUpDueAt', lead.follow_up_due_at,
      'followUpReminderAt', lead.follow_up_reminder_at,
      'followUpCompletedAt', lead.follow_up_completed_at,
      'submissionCount', lead.submission_count, 'lastSubmittedAt', lead.last_submitted_at,
      'createdAt', lead.created_at, 'updatedAt', lead.updated_at) ORDER BY
      lead.updated_at DESC, lead.id DESC) FROM (SELECT * FROM commercial_leads candidate
      WHERE (staff.role = 'PLATFORM_FOUNDER' OR candidate.assigned_to = actor)
        AND (NULLIF(input->>'leadType','') IS NULL OR candidate.lead_type = input->>'leadType')
        AND (NULLIF(input->>'stage','') IS NULL OR candidate.stage = input->>'stage')
        AND (NULLIF(input->>'owner','') IS NULL OR candidate.assigned_to = (input->>'owner')::UUID)
        AND (NULLIF(input->>'company','') IS NULL OR position(lower(input->>'company')
          IN lower(candidate.company_name)) > 0)
        AND (NULLIF(input->>'followUpStatus','') IS NULL OR
          (input->>'followUpStatus' = 'DUE' AND candidate.follow_up_due_at <= now()
            AND candidate.follow_up_completed_at IS NULL) OR
          (input->>'followUpStatus' = 'UPCOMING' AND candidate.follow_up_due_at > now()
            AND candidate.follow_up_completed_at IS NULL) OR
          (input->>'followUpStatus' = 'COMPLETED' AND candidate.follow_up_completed_at IS NOT NULL))
        AND (NULLIF(input->>'cursorUpdatedAt','') IS NULL OR (candidate.updated_at, candidate.id) <
          ((input->>'cursorUpdatedAt')::TIMESTAMPTZ, (input->>'cursorId')::UUID))
      ORDER BY candidate.updated_at DESC, candidate.id DESC LIMIT page_size + 1) lead), '[]'::JSONB));
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION authenti8_manage_platform_staff(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; target UUID; previous platform_staff;
  change_reason TEXT := trim(input->>'reason');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_staff WHERE user_id = actor
      AND role = 'PLATFORM_FOUNDER' AND status = 'ACTIVE') THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'NOT_AUTHORIZED'); END IF;
  SELECT id INTO target FROM users WHERE normalized_email = lower(trim(input->>'email'));
  IF target IS NULL OR target = actor OR length(change_reason) NOT BETWEEN 10 AND 500
      OR input->>'role' NOT IN
      ('PLATFORM_FOUNDER', 'PLATFORM_SALES') OR input->>'status' NOT IN
      ('ACTIVE', 'SUSPENDED', 'REMOVED') THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'INVALID_STAFF'); END IF;
  SELECT * INTO previous FROM platform_staff WHERE user_id = target FOR UPDATE;
  INSERT INTO platform_staff(user_id, role, status, created_by)
    VALUES (target, input->>'role', input->>'status', actor)
  ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role,
    status = EXCLUDED.status, updated_at = now();
  IF input->>'status' IN ('SUSPENDED', 'REMOVED') THEN
    UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = target;
  END IF;
  INSERT INTO audit_logs(actor_user_id, action, target_type, target_id, reason,
    previous_value, new_value)
    VALUES (actor, 'PLATFORM_STAFF_UPDATED', 'platform_staff', target::TEXT,
      change_reason, CASE WHEN previous.user_id IS NULL THEN NULL ELSE jsonb_build_object(
        'role', previous.role, 'status', previous.status) END,
      jsonb_build_object('role', input->>'role', 'status', input->>'status'));
  RETURN jsonb_build_object('updated', true);
END $$;

CREATE OR REPLACE FUNCTION authenti8_update_commercial_lead(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; staff platform_staff; lead commercial_leads;
  target UUID; next_stage TEXT := input->>'stage'; note TEXT := trim(input->>'note');
  follow_up TIMESTAMPTZ;
BEGIN
  SELECT * INTO staff FROM platform_staff WHERE user_id = actor AND status = 'ACTIVE';
  SELECT * INTO lead FROM commercial_leads WHERE id = (input->>'leadId')::UUID FOR UPDATE;
  IF staff.user_id IS NULL OR lead.id IS NULL OR (staff.role <> 'PLATFORM_FOUNDER'
      AND lead.assigned_to IS DISTINCT FROM actor) THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'NOT_AUTHORIZED'); END IF;
  IF NULLIF(input->>'assignedTo', '') IS NOT NULL
      AND (input->>'assignedTo')::UUID IS DISTINCT FROM lead.assigned_to THEN
    target := (input->>'assignedTo')::UUID;
    IF staff.role <> 'PLATFORM_FOUNDER' OR NOT EXISTS (SELECT 1 FROM platform_staff
        WHERE user_id = target AND role = 'PLATFORM_SALES' AND status = 'ACTIVE') THEN
      RETURN jsonb_build_object('updated', false, 'reason', 'INVALID_ASSIGNEE'); END IF;
    UPDATE commercial_leads SET assigned_to = target, updated_at = now() WHERE id = lead.id;
    INSERT INTO commercial_lead_activities(lead_id, actor_user_id, activity_type, detail)
      VALUES (lead.id, actor, 'ASSIGNED', jsonb_build_object('assignedTo', target));
  END IF;
  IF NULLIF(next_stage, '') IS NOT NULL AND next_stage IS DISTINCT FROM lead.stage THEN
    IF next_stage NOT IN ('NEW','CONTACTED','QUALIFIED','DEMO_SCHEDULED','PROPOSAL_SENT','WON','LOST')
      THEN RETURN jsonb_build_object('updated', false, 'reason', 'INVALID_STAGE'); END IF;
    UPDATE commercial_leads SET stage = next_stage, updated_at = now() WHERE id = lead.id;
    INSERT INTO commercial_lead_activities(lead_id, actor_user_id, activity_type, detail)
      VALUES (lead.id, actor, 'STAGE_CHANGED', jsonb_build_object(
        'previous', lead.stage, 'current', next_stage));
  END IF;
  IF note <> '' THEN
    IF length(note) > 2000 THEN RETURN jsonb_build_object('updated', false,
      'reason', 'INVALID_NOTE'); END IF;
    INSERT INTO commercial_lead_activities(lead_id, actor_user_id, activity_type, detail)
      VALUES (lead.id, actor, 'NOTE_ADDED', jsonb_build_object('note', note));
  END IF;
  IF NULLIF(input->>'followUpDueAt', '') IS NOT NULL THEN
    follow_up := (input->>'followUpDueAt')::TIMESTAMPTZ;
    UPDATE commercial_leads SET follow_up_owner = COALESCE(assigned_to, actor),
      follow_up_due_at = follow_up, follow_up_reminder_at = follow_up - interval '1 hour',
      follow_up_completed_at = NULL, follow_up_reminded_at = NULL,
      follow_up_version = follow_up_version + 1,
      updated_at = now() WHERE id = lead.id;
    INSERT INTO commercial_lead_activities(lead_id, actor_user_id, activity_type, detail)
      VALUES (lead.id, actor, 'FOLLOW_UP_SCHEDULED', jsonb_build_object('dueAt', follow_up));
  ELSIF COALESCE((input->>'completeFollowUp')::BOOLEAN, false) THEN
    IF lead.follow_up_due_at IS NULL THEN RETURN jsonb_build_object('updated', false,
      'reason', 'FOLLOW_UP_UNAVAILABLE'); END IF;
    UPDATE commercial_leads SET follow_up_completed_at = now(),
      follow_up_version = follow_up_version + 1, updated_at = now()
      WHERE id = lead.id;
    UPDATE commercial_email_outbox SET status = 'CANCELLED', lease_until = NULL
      WHERE lead_id = lead.id AND kind = 'FOLLOW_UP_REMINDER'
        AND status IN ('PENDING', 'PROCESSING');
    INSERT INTO commercial_lead_activities(lead_id, actor_user_id, activity_type, detail)
      VALUES (lead.id, actor, 'FOLLOW_UP_COMPLETED', '{}'::JSONB);
  END IF;
  RETURN jsonb_build_object('updated', true);
EXCEPTION WHEN invalid_text_representation THEN
  RETURN jsonb_build_object('updated', false, 'reason', 'INVALID_LEAD');
END $$;

CREATE OR REPLACE FUNCTION authenti8_members_overview(input JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; membership organization_members;
BEGIN
  SELECT * INTO membership FROM organization_members WHERE user_id = actor
    AND status = 'ACTIVE' ORDER BY created_at LIMIT 1;
  IF membership.user_id IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('organizationId', membership.organization_id,
    'role', membership.business_role, 'members', COALESCE((SELECT jsonb_agg(
      jsonb_build_object('userId', member.user_id, 'name', account.full_name,
        'email', account.email, 'role', member.business_role, 'status', member.status)
      ORDER BY member.created_at) FROM organization_members member JOIN users account
      ON account.id = member.user_id WHERE member.organization_id = membership.organization_id
      AND member.status <> 'REMOVED' AND (membership.business_role <> 'HR'
        OR member.user_id = actor)), '[]'::JSONB),
    'invitations', CASE WHEN membership.business_role IN ('OWNER', 'MANAGER') THEN
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', invite.id,
        'email', invite.invited_email, 'role', invite.business_role,
        'expiresAt', invite.expires_at, 'createdAt', invite.created_at)
      ORDER BY invite.created_at DESC) FROM organization_invitations invite
      WHERE invite.organization_id = membership.organization_id AND invite.accepted_at IS NULL
        AND invite.revoked_at IS NULL AND invite.expires_at > now()), '[]'::JSONB)
      ELSE '[]'::JSONB END);
END $$;

CREATE OR REPLACE FUNCTION authenti8_invite_organization_member(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; membership organization_members;
  invite_id UUID; invited_role TEXT := input->>'role'; invite_email TEXT := lower(trim(input->>'email'));
BEGIN
  SELECT * INTO membership FROM organization_members WHERE user_id = actor
    AND status = 'ACTIVE' ORDER BY created_at LIMIT 1;
  IF membership.user_id IS NULL OR membership.business_role = 'HR'
      OR (membership.business_role = 'MANAGER' AND invited_role <> 'HR') THEN
    RETURN jsonb_build_object('created', false, 'reason', 'NOT_AUTHORIZED'); END IF;
  IF invited_role NOT IN ('MANAGER', 'HR') OR invite_email !~
      '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR length(invite_email) > 320 THEN
    RETURN jsonb_build_object('created', false, 'reason', 'INVALID_INVITATION'); END IF;
  IF EXISTS (SELECT 1 FROM organization_members member JOIN users account
      ON account.id = member.user_id WHERE member.organization_id = membership.organization_id
      AND account.normalized_email = invite_email AND member.status <> 'REMOVED') THEN
    RETURN jsonb_build_object('created', false, 'reason', 'ALREADY_MEMBER'); END IF;
  UPDATE organization_invitations SET revoked_at = now()
    WHERE organization_id = membership.organization_id AND normalized_email = invite_email
      AND accepted_at IS NULL AND revoked_at IS NULL;
  INSERT INTO organization_invitations(organization_id, normalized_email, invited_email,
    business_role, token_hash, invited_by, expires_at)
  VALUES (membership.organization_id, invite_email, invite_email, invited_role, input->>'tokenHash', actor,
    (input->>'expiresAt')::TIMESTAMPTZ) RETURNING id INTO invite_id;
  INSERT INTO audit_logs(organization_id, actor_user_id, action, target_type, target_id,
    reason, new_value) VALUES (membership.organization_id, actor, 'MEMBER_INVITED',
    'organization_invitation', invite_id::TEXT, 'Organization member invited',
    jsonb_build_object('role', invited_role));
  RETURN jsonb_build_object('created', true, 'invitationId', invite_id, 'email', invite_email);
EXCEPTION WHEN check_violation OR invalid_text_representation OR not_null_violation THEN
  RETURN jsonb_build_object('created', false, 'reason', 'INVALID_INVITATION');
END $$;

CREATE OR REPLACE FUNCTION authenti8_accept_organization_invitation(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor users; invite organization_invitations; legacy_role TEXT;
BEGIN
  SELECT * INTO actor FROM users WHERE id = (input->>'userId')::UUID AND status = 'ACTIVE';
  SELECT * INTO invite FROM organization_invitations WHERE token_hash = input->>'tokenHash'
    AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE;
  IF actor.id IS NULL OR invite.id IS NULL OR actor.normalized_email <> invite.normalized_email THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'INVITATION_UNAVAILABLE'); END IF;
  IF EXISTS (SELECT 1 FROM organization_members WHERE user_id = actor.id
      AND status = 'ACTIVE' AND organization_id <> invite.organization_id) THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'ACCOUNT_ALREADY_ASSIGNED'); END IF;
  legacy_role := CASE invite.business_role WHEN 'MANAGER' THEN 'ADMIN' ELSE 'RECRUITER' END;
  INSERT INTO organization_members(organization_id, user_id, role, job_role, business_role, status)
    VALUES (invite.organization_id, actor.id, legacy_role, invite.business_role,
      invite.business_role, 'ACTIVE') ON CONFLICT (organization_id, user_id) DO UPDATE SET
      role = EXCLUDED.role, business_role = EXCLUDED.business_role, status = 'ACTIVE',
      updated_at = now();
  UPDATE organization_invitations SET accepted_by = actor.id, accepted_at = now()
    WHERE id = invite.id;
  INSERT INTO audit_logs(organization_id, actor_user_id, action, target_type, target_id,
    reason, new_value) VALUES (invite.organization_id, actor.id, 'MEMBER_INVITATION_ACCEPTED',
    'organization_member', actor.id::TEXT, 'Organization invitation accepted',
    jsonb_build_object('role', invite.business_role));
  RETURN jsonb_build_object('accepted', true, 'organizationId', invite.organization_id);
EXCEPTION WHEN invalid_text_representation THEN
  RETURN jsonb_build_object('accepted', false, 'reason', 'INVITATION_UNAVAILABLE');
END $$;

CREATE OR REPLACE FUNCTION authenti8_manage_organization_member(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor UUID := (input->>'userId')::UUID; membership organization_members;
  target organization_members; next_status TEXT := input->>'status';
BEGIN
  SELECT * INTO membership FROM organization_members WHERE user_id = actor
    AND status = 'ACTIVE' ORDER BY created_at LIMIT 1;
  SELECT * INTO target FROM organization_members WHERE organization_id = membership.organization_id
    AND user_id = (input->>'memberId')::UUID FOR UPDATE;
  IF membership.user_id IS NULL OR target.user_id IS NULL OR target.user_id = actor
      OR membership.business_role = 'HR' OR (membership.business_role = 'MANAGER'
        AND target.business_role <> 'HR') OR next_status NOT IN ('ACTIVE','SUSPENDED','REMOVED') THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'NOT_AUTHORIZED'); END IF;
  IF target.business_role = 'OWNER' AND (SELECT count(*) FROM organization_members
      WHERE organization_id = membership.organization_id AND business_role = 'OWNER'
        AND status = 'ACTIVE') <= 1 THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'OWNER_REQUIRED'); END IF;
  UPDATE organization_members SET status = next_status, updated_at = now()
    WHERE organization_id = target.organization_id AND user_id = target.user_id;
  IF next_status <> 'ACTIVE' THEN UPDATE sessions SET revoked_at = COALESCE(revoked_at, now())
    WHERE user_id = target.user_id; END IF;
  INSERT INTO audit_logs(organization_id, actor_user_id, action, target_type, target_id,
    reason, previous_value, new_value) VALUES (membership.organization_id, actor,
    'ORGANIZATION_MEMBER_UPDATED', 'organization_member', target.user_id::TEXT,
    'Organization membership changed', jsonb_build_object('status', target.status),
    jsonb_build_object('status', next_status));
  RETURN jsonb_build_object('updated', true);
EXCEPTION WHEN invalid_text_representation THEN
  RETURN jsonb_build_object('updated', false, 'reason', 'INVALID_MEMBER');
END $$;

CREATE OR REPLACE FUNCTION authenti8_current_session(input JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'user', jsonb_build_object('id', account.id, 'email', account.email,
      'fullName', account.full_name, 'emailVerified', account.email_verified_at IS NOT NULL),
    'organization', CASE WHEN organization.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', organization.id, 'name', organization.name, 'domain', organization.domain,
      'role', membership.business_role) END)
  FROM users account LEFT JOIN LATERAL (SELECT * FROM organization_members
    WHERE user_id = account.id AND status = 'ACTIVE' ORDER BY created_at LIMIT 1) membership ON true
  LEFT JOIN organizations organization ON organization.id = membership.organization_id
  WHERE account.id = (input->>'userId')::UUID AND account.status = 'ACTIVE'
$$;

REVOKE ALL ON TABLE commercial_leads, commercial_lead_activities, commercial_email_outbox, platform_staff,
  organization_invitations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION authenti8_submit_commercial_lead(JSONB),
  authenti8_commercial_overview(JSONB), authenti8_manage_platform_staff(JSONB),
  authenti8_update_commercial_lead(JSONB), authenti8_members_overview(JSONB),
  authenti8_claim_commercial_email(JSONB), authenti8_complete_commercial_email(JSONB),
  authenti8_fail_commercial_email(JSONB),
  authenti8_invite_organization_member(JSONB), authenti8_accept_organization_invitation(JSONB),
  authenti8_manage_organization_member(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_submit_commercial_lead(JSONB),
  authenti8_commercial_overview(JSONB), authenti8_manage_platform_staff(JSONB),
  authenti8_update_commercial_lead(JSONB), authenti8_members_overview(JSONB),
  authenti8_claim_commercial_email(JSONB), authenti8_complete_commercial_email(JSONB),
  authenti8_fail_commercial_email(JSONB),
  authenti8_invite_organization_member(JSONB), authenti8_accept_organization_invitation(JSONB),
  authenti8_manage_organization_member(JSONB) TO service_role;

INSERT INTO schema_migrations(version) VALUES ('044_growth_roles_invitations') ON CONFLICT DO NOTHING;
COMMIT;
