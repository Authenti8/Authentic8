import assert from "node:assert/strict";
import test from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { reportingFixture, rpc } from
  "../interviews/reporting-migration.helper.js";

test("commercial leads deduplicate submissions without exposing pipeline access", async () => {
  const fixture = await reportingFixture();
  try {
    const input = { leadType: "WAITLIST", fullName: "Taylor Recruiter",
      email: "Taylor@Example.com", companyName: "Example Hiring", sourcePath: "/",
      salesNotificationEmail: "sales@authenti8.test" };
    assert.deepEqual(await rpc(fixture.database, "authenti8_submit_commercial_lead", input),
      { accepted: true });
    assert.deepEqual(await rpc(fixture.database, "authenti8_submit_commercial_lead",
      { ...input, fullName: "Taylor Updated" }), { accepted: true });
    const row = await fixture.database.query<{ count: number; submissions: number; name: string }>(
      `SELECT count(*)::INTEGER count,max(submission_count)::INTEGER submissions,
        max(full_name) name FROM commercial_leads`);
    assert.deepEqual(row.rows[0], { count: 1, submissions: 2, name: "Taylor Updated" });
    const mail = await fixture.database.query<{ count: number }>(
      "SELECT count(*)::INTEGER count FROM commercial_email_outbox");
    assert.equal(mail.rows[0]!.count, 2);
    assert.equal(await rpc(fixture.database, "authenti8_commercial_overview",
      { userId: fixture.userId }), null);
  } finally { await fixture.database.close(); }
});

test("founders manage sales access while sales users see only assigned leads", async () => {
  const fixture = await reportingFixture();
  try {
    const salesperson = await createUser(fixture.database, "sales@growth.test", "Sales Person");
    await fixture.database.query("INSERT INTO platform_administrators(user_id) VALUES ($1)",
      [fixture.userId]);
    assert.equal(await rpc(fixture.database, "authenti8_commercial_overview",
      { userId: fixture.userId }), null);
    assert.deepEqual(await rpc(fixture.database, "authenti8_bootstrap_platform_founder",
      { userId: fixture.userId, founderEmail: "owner@reporting.test" }),
    { created: true, role: "PLATFORM_FOUNDER", status: "ACTIVE" });
    const managed = await rpc<{ updated: boolean }>(fixture.database,
      "authenti8_manage_platform_staff", { userId: fixture.userId, email: "sales@growth.test",
        role: "PLATFORM_SALES", status: "ACTIVE", reason: "Assign initial sales access" });
    assert.equal(managed.updated, true);
    await rpc(fixture.database, "authenti8_submit_commercial_lead", {
      leadType: "DEMO_REQUEST", fullName: "Demo Lead", email: "demo@company.test",
      companyName: "Demo Company" });
    const lead = await fixture.database.query<{ id: string }>("SELECT id FROM commercial_leads");
    await rpc(fixture.database, "authenti8_update_commercial_lead", {
      userId: fixture.userId, leadId: lead.rows[0]!.id, assignedTo: salesperson });
    await verifyNoOpAndReminder(fixture, salesperson, lead.rows[0]!.id);
    const overview = await rpc<{ leads: Array<{ id: string }> }>(fixture.database,
      "authenti8_commercial_overview", { userId: salesperson, followUpStatus: "UPCOMING",
        limit: 25 });
    assert.equal(overview.leads.length, 1);
    const converted = await rpc<{ converted: boolean }>(fixture.database,
      "authenti8_convert_commercial_lead", { userId: fixture.userId,
        leadId: lead.rows[0]!.id, organizationId: fixture.organizationId });
    assert.equal(converted.converted, true);
    const conversion = await fixture.database.query<{ organizationId: string; count: number }>(
      `SELECT converted_organization_id "organizationId", (SELECT count(*)::INTEGER FROM
        commercial_lead_activities WHERE activity_type='CONVERTED') count
        FROM commercial_leads WHERE id=$1`, [lead.rows[0]!.id]);
    assert.deepEqual(conversion.rows[0], { organizationId: fixture.organizationId, count: 1 });
    const denied = await rpc<{ updated: boolean }>(fixture.database,
      "authenti8_manage_platform_staff", { userId: salesperson, email: "owner@reporting.test",
        role: "PLATFORM_SALES", status: "SUSPENDED", reason: "Unauthorized role change attempt" });
    assert.equal(denied.updated, false);
    await verifyStaffAuditAndBootstrap(fixture, salesperson);
    await verifyCommercialPagination(fixture);
  } finally { await fixture.database.close(); }
});

test("owner and manager invitation authority is enforced with email-bound acceptance", async () => {
  const fixture = await reportingFixture();
  try {
    const manager = await createUser(fixture.database, "manager@growth.test", "Hiring Manager");
    const hr = await createUser(fixture.database, "hr@growth.test", "Hiring Partner");
    const stranger = await createUser(fixture.database, "stranger@growth.test", "Wrong Account");
    const managerInvite = await invite(fixture.database, fixture.userId,
      "manager@growth.test", "MANAGER", "manager-token");
    assert.equal(managerInvite.created, true);
    const wrong = await rpc<{ accepted: boolean }>(fixture.database,
      "authenti8_accept_organization_invitation", { userId: stranger,
        tokenHash: "manager-token" });
    assert.equal(wrong.accepted, false);
    const accepted = await rpc<{ accepted: boolean }>(fixture.database,
      "authenti8_accept_organization_invitation", { userId: manager,
        tokenHash: "manager-token" });
    assert.equal(accepted.accepted, true);
    assert.equal(await rpc(fixture.database, "authenti8_begin_checkout", {
      userId: manager, purpose: "EXTRA_CREDITS", quantity: 10 }), null);
    assert.equal((await invite(fixture.database, manager, "hr@growth.test", "HR",
      "hr-token")).created, true);
    assert.equal((await invite(fixture.database, manager, "owner-two@growth.test", "MANAGER",
      "forbidden-token")).created, false);
    assert.equal((await rpc<{ accepted: boolean }>(fixture.database,
      "authenti8_accept_organization_invitation", { userId: hr,
        tokenHash: "hr-token" })).accepted, true);
    assert.equal((await invite(fixture.database, hr, "another@growth.test", "HR",
      "hr-forbidden-token")).created, false);
  } finally { await fixture.database.close(); }
});

test("expired invitations fail and member suspension revokes active sessions", async () => {
  const fixture = await reportingFixture();
  try {
    const hr = await createUser(fixture.database, "session-hr@growth.test", "Session HR");
    await fixture.database.query(`INSERT INTO organization_invitations(organization_id,
      normalized_email,invited_email,business_role,token_hash,invited_by,expires_at)
      VALUES ($1,'session-hr@growth.test','session-hr@growth.test','HR','expired-token',$2,
        now()+interval '1 second')`, [fixture.organizationId, fixture.userId]);
    await fixture.database.query(`UPDATE organization_invitations SET created_at=now()-interval '2 hours',
      expires_at=now()-interval '1 hour' WHERE token_hash='expired-token'`);
    const expired = await rpc<{ accepted: boolean }>(fixture.database,
      "authenti8_accept_organization_invitation", { userId: hr, tokenHash: "expired-token" });
    assert.equal(expired.accepted, false);
    await fixture.database.query(`INSERT INTO organization_members(organization_id,user_id,role,
      job_role,business_role) VALUES ($1,$2,'RECRUITER','HR','HR')`, [fixture.organizationId, hr]);
    await fixture.database.query(`INSERT INTO sessions(user_id,token_hash,expires_at)
      VALUES ($1,'active-member-session',now()+interval '1 hour')`, [hr]);
    const suspended = await rpc<{ updated: boolean }>(fixture.database,
      "authenti8_manage_organization_member", { userId: fixture.userId, memberId: hr,
        status: "SUSPENDED" });
    assert.equal(suspended.updated, true);
    const session = await fixture.database.query<{ revoked: boolean }>(`SELECT
      revoked_at IS NOT NULL revoked FROM sessions WHERE token_hash='active-member-session'`);
    assert.equal(session.rows[0]!.revoked, true);
    const activeOrganization = await fixture.database.query<{ id: string | null }>(
      "SELECT authenti8_user_organization($1) id", [hr]);
    assert.equal(activeOrganization.rows[0]!.id, null);
  } finally { await fixture.database.close(); }
});

async function createUser(database: PGlite, email: string, fullName: string) {
  const user = await rpc<{ id: string }>(database, "authenti8_create_user", { email, fullName });
  await database.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [user.id]);
  return user.id;
}

function invite(database: PGlite, userId: string, email: string, role: string, tokenHash: string) {
  return rpc<{ created: boolean }>(database, "authenti8_invite_organization_member", {
    userId, email, role, tokenHash, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
}

async function verifyStaffAuditAndBootstrap(fixture: Awaited<ReturnType<typeof reportingFixture>>,
  salesperson: string) {
  await rpc(fixture.database, "authenti8_manage_platform_staff", { userId: fixture.userId,
    email: "sales@growth.test", role: "PLATFORM_SALES", status: "SUSPENDED",
    reason: "Sales access no longer required" });
  const audit = await fixture.database.query<{ previousRole: string; reason: string }>(`SELECT
    previous_value->>'role' "previousRole",reason FROM audit_logs
    WHERE action='PLATFORM_STAFF_UPDATED' AND target_id=$1 ORDER BY created_at DESC LIMIT 1`,
  [salesperson]);
  assert.deepEqual(audit.rows[0], { previousRole: "PLATFORM_SALES",
    reason: "Sales access no longer required" });
  await fixture.database.query(`INSERT INTO sessions(user_id,token_hash,expires_at)
    VALUES ($1,'removed-sales-session',now()+interval '1 hour')`, [salesperson]);
  await rpc(fixture.database, "authenti8_manage_platform_staff", { userId: fixture.userId,
    email: "sales@growth.test", role: "PLATFORM_SALES", status: "REMOVED",
    reason: "Remove departed sales team member" });
  const removed = await fixture.database.query<{ status: string; revoked: boolean }>(`SELECT
    staff.status, session.revoked_at IS NOT NULL revoked FROM platform_staff staff JOIN sessions session
    ON session.user_id=staff.user_id WHERE staff.user_id=$1 AND session.token_hash='removed-sales-session'`,
  [salesperson]);
  assert.deepEqual(removed.rows[0], { status: "REMOVED", revoked: true });
  assert.equal(await rpc(fixture.database, "authenti8_commercial_overview",
    { userId: salesperson }), null);
  assert.deepEqual(await rpc(fixture.database, "authenti8_bootstrap_platform_founder",
    { userId: salesperson, founderEmail: "sales@growth.test" }),
  { created: true, role: "PLATFORM_FOUNDER", status: "ACTIVE" });
  const bootstrapAudit = await fixture.database.query<{ previousRole: string }>(`SELECT
    previous_value->>'role' "previousRole" FROM audit_logs
    WHERE action='PLATFORM_FOUNDER_BOOTSTRAPPED' AND target_id=$1`, [salesperson]);
  assert.equal(bootstrapAudit.rows[0]!.previousRole, "PLATFORM_SALES");
}

async function verifyCommercialPagination(fixture: Awaited<ReturnType<typeof reportingFixture>>) {
  for (const [email, company] of [["one@paging.test", "Paging One"],
    ["two@paging.test", "Paging Two"], ["ignored@other.test", "Other Company"]]) {
    await rpc(fixture.database, "authenti8_submit_commercial_lead", { leadType: "WAITLIST",
      fullName: "Paging Lead", email, companyName: company });
  }
  const page = await rpc<{ leads: Array<{ companyName: string }> }>(fixture.database,
    "authenti8_commercial_overview", { userId: fixture.userId, company: "paging", limit: 1 });
  assert.equal(page.leads.length, 2);
  assert.equal(page.leads.every((lead) => lead.companyName.startsWith("Paging")), true);
}

async function verifyNoOpAndReminder(fixture: Awaited<ReturnType<typeof reportingFixture>>,
  salesperson: string, leadId: string) {
  await rpc(fixture.database, "authenti8_update_commercial_lead", { userId: fixture.userId,
    leadId, assignedTo: salesperson, stage: "NEW" });
  const unchanged = await fixture.database.query<{ count: number }>(`SELECT count(*)::INTEGER count
    FROM commercial_lead_activities WHERE activity_type IN ('ASSIGNED','STAGE_CHANGED')`);
  assert.equal(unchanged.rows[0]!.count, 1);
  await fixture.database.query("UPDATE commercial_email_outbox SET status='SENT'");
  await rpc(fixture.database, "authenti8_update_commercial_lead", { userId: salesperson, leadId,
    followUpDueAt: new Date(Date.now() + 30 * 60_000).toISOString() });
  const reminder = await rpc<{ id: string; attempts: number; kind: string }>(fixture.database,
    "authenti8_claim_commercial_email");
  assert.equal(reminder.kind, "FOLLOW_UP_REMINDER");
  await rpc(fixture.database, "authenti8_complete_commercial_email", reminder);
  const reminded = await fixture.database.query<{ sent: boolean }>(`SELECT
    follow_up_reminded_at IS NOT NULL sent FROM commercial_leads WHERE id=$1`, [leadId]);
  assert.equal(reminded.rows[0]!.sent, true);
  await rpc(fixture.database, "authenti8_update_commercial_lead", { userId: salesperson, leadId,
    followUpDueAt: new Date(Date.now() + 30 * 60_000).toISOString() });
  const stale = await rpc<{ id: string; attempts: number }>(fixture.database,
    "authenti8_claim_commercial_email");
  await rpc(fixture.database, "authenti8_update_commercial_lead", { userId: salesperson, leadId,
    completeFollowUp: true });
  assert.equal(await rpc(fixture.database, "authenti8_validate_commercial_email", stale), false);
  const cancelled = await fixture.database.query<{ status: string }>(
    "SELECT status FROM commercial_email_outbox WHERE id=$1", [stale.id]);
  assert.equal(cancelled.rows[0]!.status, "CANCELLED");
  await rpc(fixture.database, "authenti8_update_commercial_lead", { userId: salesperson, leadId,
    followUpDueAt: new Date(Date.now() + 30 * 60_000).toISOString() });
}
