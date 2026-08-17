import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { insertInterview, reportingFixture, rpc } from
  "../interviews/reporting-migration.helper.js";

test("owner billing delegation is manager-specific, revocable, and never available to HR", async () => {
  const fixture = await reportingFixture();
  try {
    const manager = await member(fixture.database, fixture.organizationId, "billing-manager@release.test", "MANAGER");
    const hr = await member(fixture.database, fixture.organizationId, "billing-hr@release.test", "HR");
    assert.equal(await rpc(fixture.database, "authenti8_begin_checkout", {
      userId: manager, purpose: "EXTRA_CREDITS", quantity: 2 }), null);
    const granted = await rpc<{ updated: boolean }>(fixture.database,
      "authenti8_manage_billing_grant", { userId: fixture.userId, managerUserId: manager,
        reason: "Manager may purchase approved interview credits" });
    assert.equal(granted.updated, true);
    const checkout = await rpc<{ checkoutIntentId: string }>(fixture.database,
      "authenti8_begin_checkout", { userId: manager, purpose: "EXTRA_CREDITS", quantity: 2,
        amountMinor: 1000 });
    assert.match(checkout.checkoutIntentId, /^[0-9a-f-]{36}$/i);
    await rpc(fixture.database, "authenti8_manage_billing_grant", { userId: fixture.userId,
      managerUserId: manager, reason: "Limit delegated purchases to twelve dollars monthly",
      monthlyLimitMinor: 1200 });
    const retried = await rpc<{ checkoutIntentId: string; reused: boolean }>(fixture.database,
      "authenti8_begin_checkout", { userId: manager, purpose: "EXTRA_CREDITS", quantity: 2,
        amountMinor: 1000 });
    assert.equal(retried.reused && retried.checkoutIntentId === checkout.checkoutIntentId, true);
    assert.equal(await rpc(fixture.database, "authenti8_begin_checkout", {
      userId: manager, purpose: "EXTRA_CREDITS", quantity: 1, amountMinor: 500 }), null);
    await assert.rejects(fixture.database.query(`INSERT INTO billing_provider_payments(payment_id,
      organization_id,checkout_intent_id,purpose,quantity,amount_minor,event_occurred_at)
      VALUES('delegated-over-limit',$1,$2,'EXTRA_CREDITS',2,1500,now())`,
    [fixture.organizationId, checkout.checkoutIntentId]), /owner authorization/);
    await fixture.database.query(`UPDATE billing_checkout_sessions SET created_at=
      now()-interval '26 hours' WHERE id=$1`, [checkout.checkoutIntentId]);
    assert.equal(await rpc(fixture.database, "authenti8_begin_checkout", {
      userId: hr, purpose: "EXTRA_CREDITS", quantity: 2 }), null);
    await rpc(fixture.database, "authenti8_manage_billing_grant", { userId: fixture.userId,
      managerUserId: manager, revoke: true, reason: "Delegated purchasing access is no longer needed" });
    await fixture.database.query(`INSERT INTO billing_provider_payments(payment_id,
      organization_id,checkout_intent_id,purpose,quantity,amount_minor,event_occurred_at)
      VALUES('delegated-after-revoke',$1,$2,'EXTRA_CREDITS',2,1000,now())`,
    [fixture.organizationId, checkout.checkoutIntentId]);
    await assert.rejects(fixture.database.query(`INSERT INTO billing_provider_payments(payment_id,
      organization_id,checkout_intent_id,purpose,quantity,amount_minor,event_occurred_at)
      VALUES('delegated-after-revoke-wrong-amount',$1,$2,'EXTRA_CREDITS',2,1500,now())`,
    [fixture.organizationId, checkout.checkoutIntentId]), /owner authorization/);
    assert.equal(await rpc(fixture.database, "authenti8_begin_checkout", {
      userId: manager, purpose: "EXTRA_CREDITS", quantity: 2 }), null);
    const attribution = await fixture.database.query<{ purchaser: string; owner: string }>(`SELECT
      purchaser_user_id purchaser,approving_owner_user_id owner FROM billing_checkout_sessions
      WHERE id=$1`, [checkout.checkoutIntentId]);
    assert.deepEqual(attribution.rows[0], { purchaser: manager, owner: fixture.userId });
  } finally { await fixture.database.close(); }
});

test("HR allocations reserve and release atomically with the organization interview", async () => {
  const fixture = await reportingFixture();
  try {
    const hr = await member(fixture.database, fixture.organizationId,
      "wallet-hr@release.test", "HR");
    const adjusted = await rpc<{ updated: boolean; available: number }>(fixture.database,
      "authenti8_adjust_hr_wallet", { userId: fixture.userId, memberUserId: hr,
        operation: "GRANT", quantity: 3, reason: "Allocate three upcoming interview links",
        idempotencyKey: randomUUID() });
    assert.deepEqual(adjusted, { updated: true, available: 3 });
    const interviewId = await insertInterview(fixture.database, fixture.organizationId,
      "Wallet Candidate", "wallet-candidate@release.test", new Date(Date.now() + 60 * 60_000),
      "EXCLUDED");
    await fixture.database.query("UPDATE interviews SET responsible_member_user_id=$1 WHERE id=$2",
      [hr, interviewId]);
    await fixture.database.query("UPDATE interviews SET status='DETECTED' WHERE id=$1", [interviewId]);
    assert.equal(await walletBalance(fixture.database, fixture.organizationId, hr), 2);
    const reservation = await fixture.database.query<{ member: string; status: string }>(`SELECT
      member_user_id member,status FROM credit_reservations WHERE interview_id=$1`, [interviewId]);
    assert.deepEqual(reservation.rows[0], { member: hr, status: "RESERVED" });
    assert.equal((await rpc<{ released: boolean }>(fixture.database, "authenti8_release_credit",
      { interviewId })).released, true);
    assert.equal(await walletBalance(fixture.database, fixture.organizationId, hr), 3);
    const stranger = await member(fixture.database, fixture.organizationId,
      "other-hr@release.test", "HR");
    assert.equal(await rpc(fixture.database, "authenti8_meeting_detail",
      { userId: stranger, interviewId }), null);
  } finally { await fixture.database.close(); }
});

test("verified enterprise payment activates one agreement and posts credits exactly once", async () => {
  const fixture = await reportingFixture();
  try {
    await rpc(fixture.database, "authenti8_bootstrap_platform_founder", {
      userId: fixture.userId, founderEmail: "owner@reporting.test" });
    await rpc(fixture.database, "authenti8_submit_commercial_lead", { leadType: "WAITLIST",
      fullName: "Enterprise Owner", email: "enterprise@release.test", companyName: "Release Corp" });
    const lead = await fixture.database.query<{ id: string }>("SELECT id FROM commercial_leads");
    await fixture.database.query(`UPDATE commercial_leads SET stage='WON',converted_organization_id=$1
      WHERE id=$2`, [fixture.organizationId, lead.rows[0]!.id]);
    const proposal = await rpc<{ agreementId: string }>(fixture.database,
      "authenti8_upsert_enterprise_proposal", { userId: fixture.userId, leadId: lead.rows[0]!.id,
        organizationId: fixture.organizationId, contractValueMinor: 250000, currency: "USD",
        billingInterval: "ANNUAL", purchasedCredits: 500,
        effectiveAt: new Date().toISOString(), paymentTermsDays: 30 });
    const invoice = await rpc<{ invoiceId: string }>(fixture.database,
      "authenti8_issue_enterprise_invoice", { userId: fixture.userId,
        agreementId: proposal.agreementId, provider: "DODO", providerInvoiceId: "enterprise-invoice-1",
        dueAt: new Date(Date.now() + 30 * 86400000).toISOString(),
        signedDocumentReference: "contracts/release-corp-v1" });
    assert.match(invoice.invoiceId, /^[0-9a-f-]{36}$/i);
    const payment = { provider: "DODO", providerInvoiceId: "enterprise-invoice-1",
      providerPaymentId: "enterprise-payment-1", providerEventId: "enterprise-event-1",
      amountMinor: 250000, currency: "USD", credits: 500 };
    assert.deepEqual(await rpc(fixture.database, "authenti8_apply_enterprise_payment", payment),
      { applied: true, credits: 500 });
    assert.equal((await rpc<{ duplicate: boolean }>(fixture.database,
      "authenti8_apply_enterprise_payment", payment)).duplicate, true);
    assert.deepEqual(await rpc(fixture.database, "authenti8_apply_enterprise_payment", {
      ...payment, providerEventId: "enterprise-event-replayed" }),
    { applied: false, reason: "PAYMENT_ID_CONFLICT" });
    const posted = await fixture.database.query<{ count: number; amount: number }>(`SELECT
      count(*)::INTEGER count,COALESCE(sum(amount),0)::INTEGER amount FROM credit_transactions
      WHERE idempotency_key='enterprise-payment:DODO:enterprise-event-1'`);
    assert.deepEqual(posted.rows[0], { count: 1, amount: 500 });
  } finally { await fixture.database.close(); }
});

test("enterprise invoice identifiers cannot cross agreement boundaries", async () => {
  const fixture = await reportingFixture();
  try {
    await rpc(fixture.database, "authenti8_bootstrap_platform_founder", {
      userId: fixture.userId, founderEmail: "owner@reporting.test" });
    const agreements: string[] = [];
    for (const suffix of ["first", "second"]) {
      await rpc(fixture.database, "authenti8_submit_commercial_lead", { leadType: "WAITLIST",
        fullName: `${suffix} Owner`, email: `${suffix}@invoice.test`, companyName: `${suffix} Corp` });
      const lead = await fixture.database.query<{ id: string }>(
        "SELECT id FROM commercial_leads WHERE email=$1", [`${suffix}@invoice.test`]);
      await fixture.database.query(`UPDATE commercial_leads SET stage='WON',
        converted_organization_id=$1 WHERE id=$2`, [fixture.organizationId, lead.rows[0]!.id]);
      const proposal = await rpc<{ agreementId: string }>(fixture.database,
        "authenti8_upsert_enterprise_proposal", { userId: fixture.userId,
          leadId: lead.rows[0]!.id, organizationId: fixture.organizationId,
          contractValueMinor: suffix === "first" ? 10000 : 20000, currency: "USD",
          billingInterval: "ANNUAL", purchasedCredits: suffix === "first" ? 10 : 20,
          effectiveAt: new Date().toISOString(), paymentTermsDays: 30 });
      agreements.push(proposal.agreementId);
    }
    const common = { userId: fixture.userId, provider: "DODO",
      providerInvoiceId: "provider-shared-invoice", dueAt: new Date().toISOString(),
      signedDocumentReference: "contracts/signed-v1" };
    assert.equal((await rpc<{ created: boolean }>(fixture.database,
      "authenti8_issue_enterprise_invoice", { ...common, agreementId: agreements[0] })).created, true);
    assert.deepEqual(await rpc(fixture.database, "authenti8_issue_enterprise_invoice",
      { ...common, agreementId: agreements[1] }),
    { created: false, reason: "INVOICE_ID_CONFLICT" });
  } finally { await fixture.database.close(); }
});

test("HR acknowledgement and commercial retention remain identity scoped", async () => {
  const fixture = await reportingFixture();
  try {
    const first = await member(fixture.database, fixture.organizationId, "first-hr@scope.test", "HR");
    const second = await member(fixture.database, fixture.organizationId, "second-hr@scope.test", "HR");
    for (const [user, key] of [[first, "first"], [second, "second"]] as const) {
      const interview = await insertInterview(fixture.database, fixture.organizationId,
        `${key} interview`, `${key}@candidate.test`, new Date(Date.now() + 3600000), "EXCLUDED");
      await fixture.database.query("UPDATE interviews SET responsible_member_user_id=$1 WHERE id=$2",
        [user, interview]);
      await fixture.database.query(`INSERT INTO workspace_notifications(organization_id,interview_id,
        kind,message,severity,idempotency_key) VALUES($1,$2,'TEST','Scoped notification','WARNING',$3)`,
      [fixture.organizationId, interview, `scope-${key}`]);
    }
    const recipients = await fixture.database.query<{ recipient: string }>(`SELECT outbox.recipient
      FROM notification_email_outbox outbox JOIN workspace_notifications notice
        ON notice.id=outbox.notification_id WHERE notice.idempotency_key='scope-first'`);
    assert.equal(recipients.rows.some((row) => row.recipient === "first-hr@scope.test"), true);
    assert.equal(recipients.rows.some((row) => row.recipient === "second-hr@scope.test"), false);
    const staleNotice = await fixture.database.query<{ id: string }>(`INSERT INTO
      workspace_notifications(organization_id,interview_id,kind,message,severity,idempotency_key)
      VALUES($1,NULL,'TEST','Legacy broad notification','WARNING','legacy-broad') RETURNING id`,
    [fixture.organizationId]);
    await fixture.database.query(`INSERT INTO notification_email_outbox(notification_id,recipient,
      status,attempts,lease_until) VALUES($1,'second-hr@scope.test','PROCESSING',1,
      now()+interval '30 seconds') ON CONFLICT DO NOTHING`, [staleNotice.rows[0]!.id]);
    const staleOutbox = await fixture.database.query<{ id: string }>(`SELECT id FROM
      notification_email_outbox WHERE notification_id=$1 AND recipient='second-hr@scope.test'`,
    [staleNotice.rows[0]!.id]);
    assert.equal(await rpc(fixture.database, "authenti8_validate_notification_email",
      { id: staleOutbox.rows[0]!.id, attempts: 1 }), false);
    const staleStatus = await fixture.database.query<{ status: string }>(
      "SELECT status FROM notification_email_outbox WHERE id=$1", [staleOutbox.rows[0]!.id]);
    assert.equal(staleStatus.rows[0]!.status, "FAILED");
    assert.deepEqual(await rpc(fixture.database, "authenti8_acknowledge_notifications",
      { userId: first }), { acknowledged: 1 });
    const unread = await fixture.database.query<{ count: number }>(`SELECT count(*)::INTEGER count
      FROM workspace_notifications WHERE read_at IS NULL AND idempotency_key LIKE 'scope-%'`);
    assert.equal(unread.rows[0]!.count, 1);
    await rpc(fixture.database, "authenti8_submit_commercial_lead", { leadType: "WAITLIST",
      fullName: "Retained Person", email: "private@retention.test", companyName: "Privacy Corp" });
    await fixture.database.query("UPDATE commercial_leads SET last_submitted_at=now()-interval '2 days'");
    await rpc(fixture.database, "authenti8_retain_commercial_contacts", { retentionDays: 1 });
    const recipient = await fixture.database.query<{ recipient: string }>(`SELECT recipient FROM
      commercial_email_outbox WHERE kind='LEAD_CONFIRMATION'`);
    assert.equal(recipient.rows.some((row) => row.recipient === "private@retention.test"), false);
  } finally { await fixture.database.close(); }
});

async function member(database: PGlite, organizationId: string, email: string,
  role: "MANAGER" | "HR") {
  const user = await rpc<{ id: string }>(database, "authenti8_create_user", {
    email, fullName: email.split("@")[0] });
  await database.query(`UPDATE users SET email_verified_at=now() WHERE id=$1`, [user.id]);
  await database.query(`INSERT INTO organization_members(organization_id,user_id,role,job_role,
    business_role,status) VALUES($1,$2,$3,$4,$4,'ACTIVE')`, [organizationId, user.id,
    role === "MANAGER" ? "ADMIN" : "RECRUITER", role]);
  return user.id;
}

async function walletBalance(database: PGlite, organizationId: string, userId: string) {
  const result = await database.query<{ balance: number }>(
    "SELECT authenti8_wallet_balance($1,$2)::INTEGER balance", [organizationId, userId]);
  return result.rows[0]!.balance;
}
