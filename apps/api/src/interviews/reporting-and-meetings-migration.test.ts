import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { exerciseDisputeReview, insertInterview, loadMigrations, organizationInput, reportingFixture, rpc,
  seedCandidateIdentity, type ReportingFixture } from "./reporting-migration.helper.js";
test("meeting pages are tenant-scoped, filterable, and cursor-paginated", async () => {
  const fixture = await reportingFixture();
  try {
    await insertInterview(fixture.database, fixture.organizationId, "Alpha Candidate",
      "alpha@candidate.test", new Date(Date.now() + 60_000));
    await insertInterview(fixture.database, fixture.organizationId, "Beta Candidate",
      "beta@candidate.test", new Date(Date.now() + 120_000));
    await insertInterview(fixture.database, fixture.otherOrganizationId, "Hidden Candidate",
      "hidden@candidate.test", new Date(Date.now() + 180_000));
    const first = await rpc<MeetingsPage>(fixture.database, "authenti8_meetings_page", {
      userId: fixture.userId, status: "UPCOMING", limit: 1,
    });
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0]!.candidateEmail, "beta@candidate.test");
    assert.ok(first.nextCursor);
    const [cursorStart, cursorId] = Buffer.from(first.nextCursor!, "base64")
      .toString("utf8").split("|");
    const second = await rpc<MeetingsPage>(fixture.database, "authenti8_meetings_page", {
      userId: fixture.userId, status: "UPCOMING", limit: 1, cursorStart, cursorId,
    });
    assert.equal(second.items[0]!.candidateEmail, "alpha@candidate.test");
    const searched = await rpc<MeetingsPage>(fixture.database, "authenti8_meetings_page", {
      userId: fixture.userId, candidate: "HIDDEN", limit: 25,
    });
    assert.deepEqual(searched.items, []);
    const wildcard = await rpc<MeetingsPage>(fixture.database, "authenti8_meetings_page", {
      userId: fixture.userId, candidate: "%", limit: 25,
    });
    assert.deepEqual(wildcard.items, []);
    await insertInterview(fixture.database, fixture.organizationId, "Local Date Candidate",
      "local-date@candidate.test", new Date("2030-08-15T12:00:00.000Z"));
    const localDay = await rpc<MeetingsPage>(fixture.database, "authenti8_meetings_page", {
      userId: fixture.userId, from: "2030-08-15", to: "2030-08-15", limit: 25,
    });
    assert.deepEqual(localDay.items.map((item) => item.candidateEmail),
      ["local-date@candidate.test"]);
    assert.match(loadMigrations(), /::DATE AT TIME ZONE org_timezone/);
    const invalidLimit = await rpc<MeetingsPage & { invalid?: boolean }>(fixture.database,
      "authenti8_meetings_page", { userId: fixture.userId, limit: "999999999999999999999" });
    assert.equal(invalidLimit.invalid, true);
  } finally { await fixture.database.close(); }
});
test("provider invoices are restricted to workspace owners and admins", async () => {
  const fixture = await reportingFixture();
  try {
    const recruiter = await rpc<{ id: string }>(fixture.database, "authenti8_create_user", {
      email: "recruiter@reporting.test", fullName: "Reporting Recruiter",
    });
    await fixture.database.query("UPDATE users SET email_verified_at = now() WHERE id = $1",
      [recruiter.id]);
    await fixture.database.query(`INSERT INTO organization_members(organization_id, user_id,
      role, job_role) VALUES ($1,$2,'RECRUITER','Recruiter')`,
    [fixture.organizationId, recruiter.id]);
    await fixture.database.query(`INSERT INTO billing_provider_payments(organization_id,
      payment_id, purpose, event_occurred_at) VALUES
      ($1,'pay_invoice_access','EXTRA_CREDITS',now())`,
    [fixture.organizationId]);
    const owner = await rpc<{ paymentId: string } | null>(fixture.database,
      "authenti8_billing_payment_context", {
        userId: fixture.userId, paymentId: "pay_invoice_access",
      });
    const readOnly = await rpc<{ paymentId: string } | null>(fixture.database,
      "authenti8_billing_payment_context", {
        userId: recruiter.id, paymentId: "pay_invoice_access",
      });
    assert.equal(owner?.paymentId, "pay_invoice_access");
    assert.equal(readOnly, null);
  } finally { await fixture.database.close(); }
});
test("evidence is append-only and final reports remain immutable snapshots", async () => {
  const fixture = await reportingFixture();
  try {
    const interviewId = await insertInterview(fixture.database, fixture.organizationId,
      "Report Candidate", "report@candidate.test", new Date(Date.now() - 60_000),
      "REPORT_PROCESSING");
    const sessionId = randomUUID();
    await fixture.database.query(`INSERT INTO verification_sessions(id, interview_id,
      candidate_email, status, consent_version, consented_at, eligible_start, eligible_end,
      monitoring_started_at, monitoring_ended_at, coverage_percentage, monitoring_health)
      VALUES ($1,$2,$3,'COMPLETED','v1',now(),now()-interval '1 hour',now()+interval '1 hour',
        now()-interval '12 minutes',now(),98.5,'COMPLETED')`,
    [sessionId, interviewId, "report@candidate.test"]);
    await fixture.database.query(`INSERT INTO candidate_devices(verification_session_id,
      public_key, platform, platform_version, agent_version)
      VALUES ($1,'key','WINDOWS','11','1.0.0')`, [sessionId]);
    await fixture.database.query(`INSERT INTO monitoring_interruptions(verification_session_id,
      started_at, ended_at, reason) VALUES ($1,now()-interval '10 minutes',
      now()-interval '8 minutes','HEARTBEAT_MISSED')`, [sessionId]);
    await fixture.database.query(`INSERT INTO recruiter_live_events(interview_id, source_kind,
      source_reference, kind, message, idempotency_key)
      VALUES ($1,'INTERVIEW_LIFECYCLE','ready','MEETING_COMPLETED','Meeting completed',$2)`,
    [interviewId, `completed:${interviewId}`]);
    await fixture.database.query(`INSERT INTO telemetry_events(id, verification_session_id,
      sequence_number, event_type, event_timestamp, monotonic_timestamp, platform, payload,
      payload_hash, agent_version, rule_pack_version, signature, event_chain_hash) VALUES
      ($1,$3,1,'HEARTBEAT',now()-interval '2 minutes',1,'WINDOWS','{}','payload-1','1.0.0',
        'agent-pack-v2','signature-1',$4),
      ($2,$3,2,'BROWSER_EXTENSION_CHANGED',now()-interval '1 minute',2,'WINDOWS',
        '{"rulePackVersion":"browser-pack-v1"}','payload-2','1.0.0','ignored-agent-pack',
        'signature-2',$5)`, [randomUUID(), randomUUID(), sessionId, "a".repeat(64), "b".repeat(64)]);
    const generatedResult = await fixture.database.query<{
      result: { generated: boolean; reportId: string };
    }>("SELECT authenti8_generate_report($1) AS result", [interviewId]);
    const generated = generatedResult.rows[0]!.result;
    assert.equal(generated.generated, true);
    const detail = await rpc<{ report: { monitoringCoverage: number; durationSeconds: number;
      rulePackVersions: string[]; disclaimer: string } }>(
      fixture.database, "authenti8_meeting_detail", { userId: fixture.userId, interviewId });
    assert.equal(Number(detail.report.monitoringCoverage), 83.33);
    assert.equal(detail.report.durationSeconds, 720);
    assert.deepEqual(detail.report.rulePackVersions, ["agent-pack-v2", "browser-pack-v1"]);
    assert.match(detail.report.disclaimer, /not proof/i);
    await assert.rejects(fixture.database.query("UPDATE reports SET version = 2 WHERE id = $1",
      [generated.reportId]), /append-only/);
    await assert.rejects(fixture.database.query(
      "DELETE FROM recruiter_live_events WHERE interview_id = $1", [interviewId]), /append-only/);
  } finally { await fixture.database.close(); }
});
test("critical notifications deduplicate and enqueue one email per member", async () => {
  const fixture = await reportingFixture();
  try {
    const suspended = await rpc<{ id: string }>(fixture.database, "authenti8_create_user", {
      email: "suspended@reporting.test", fullName: "Suspended Recruiter",
    });
    await fixture.database.query(`UPDATE users SET email_verified_at = now(), status = 'SUSPENDED'
      WHERE id = $1`, [suspended.id]);
    await fixture.database.query(`INSERT INTO organization_members(organization_id, user_id,
      role, job_role) VALUES ($1,$2,'RECRUITER','Recruiter')`,
    [fixture.organizationId, suspended.id]);
    const interviewId = await insertInterview(fixture.database, fixture.organizationId,
      "Alert Candidate", "alert@candidate.test", new Date());
    const key = `confirmed:${interviewId}`;
    await fixture.database.query(`INSERT INTO workspace_notifications(organization_id,
      interview_id, kind, message, idempotency_key) VALUES ($1,$2,'CONFIRMED_DETECTION',
      'Prohibited assistance confirmed',$3) ON CONFLICT DO NOTHING`,
    [fixture.organizationId, interviewId, key]);
    await fixture.database.query(`INSERT INTO workspace_notifications(organization_id,
      interview_id, kind, message, idempotency_key) VALUES ($1,$2,'CONFIRMED_DETECTION',
      'Prohibited assistance confirmed',$3) ON CONFLICT DO NOTHING`,
    [fixture.organizationId, interviewId, key]);
    const notices = await rpc<Array<{ severity: string; linkPath: string }>>(fixture.database,
      "authenti8_notifications", { userId: fixture.userId });
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.severity, "CRITICAL");
    assert.equal(notices[0]!.linkPath, `/dashboard/meetings/${interviewId}`);
    const claimedResult = await fixture.database.query<{
      result: { id: string; attempts: number; recipient: string; title: string };
    }>("SELECT authenti8_claim_notification_email() AS result");
    const claimed = claimedResult.rows[0]!.result;
    assert.equal(claimed.recipient, "owner@reporting.test");
    assert.match(claimed.title, /confirmed/i);
    const recipients = await fixture.database.query<{ recipient: string }>(
      "SELECT recipient FROM notification_email_outbox");
    assert.deepEqual(recipients.rows.map((row) => row.recipient), ["owner@reporting.test"]);
    const renewed = await rpc<{ renewed: boolean }>(fixture.database,
      "authenti8_renew_notification_email", { id: claimed.id, attempts: claimed.attempts });
    assert.equal(renewed.renewed, true);
  } finally { await fixture.database.close(); }
});
test("low-credit notification is emitted only when the balance crosses the threshold", async () => {
  const fixture = await reportingFixture();
  try {
    await fixture.database.query(`INSERT INTO credit_transactions(organization_id, amount, kind,
      reference_id, idempotency_key) VALUES
      ($1,2,'EXTRA_PURCHASE','purchase',$2),
      ($1,-10,'ALLOWANCE_CONSUMED',authenti8_period_key($1),$3),
      ($1,-1,'EXTRA_CONSUMED','interview',$4)`, [fixture.organizationId,
      `purchase:${randomUUID()}`, `threshold:${randomUUID()}`, `below:${randomUUID()}`]);
    const notices = await rpc<Array<{ kind: string }>>(fixture.database,
      "authenti8_notifications", { userId: fixture.userId });
    assert.equal(notices.filter((notice) => notice.kind === "LOW_CREDITS").length, 1);
    const billing = await rpc<{ used: number; includedUsed: number }>(fixture.database,
      "authenti8_billing_summary", { userId: fixture.userId });
    assert.equal(billing.used, 11);
    assert.equal(billing.includedUsed, 10);
  } finally { await fixture.database.close(); }
});
test("migration backfills completed reports and terminal failures leave processing", async () => {
  const database = new PGlite({ extensions: { pgcrypto, pg_trgm } });
  try {
    await database.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY)");
    await database.exec(loadMigrations((file) => file < "038_"));
    const owner = await rpc<{ id: string }>(database, "authenti8_create_user", {
      email: "backfill@reporting.test", fullName: "Backfill Owner",
    });
    await database.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [owner.id]);
    const organization = await rpc<{ organization: { id: string } }>(database,
      "authenti8_create_organization", organizationInput(owner.id, "backfill-reporting.test"));
    const interviewId = await insertInterview(database, organization.organization.id,
      "Backfill Candidate", "backfill@candidate.test", new Date(Date.now() - 3_600_000),
      "MEETING_COMPLETED");
    await database.exec(loadMigrations((file) => file >= "038_"));
    const searchIndex = await database.query<{ indexdef: string }>(`SELECT indexdef
      FROM pg_indexes WHERE indexname = 'interviews_candidate_search_trgm_idx'`);
    assert.match(searchIndex.rows[0]?.indexdef ?? "", /organization_id.*gin_trgm_ops/i);
    const job = await database.query<{ status: string }>(
      "SELECT status FROM report_generation_jobs WHERE interview_id = $1", [interviewId]);
    assert.equal(job.rows[0]?.status, "PENDING");
    await database.exec(`CREATE FUNCTION reject_test_report() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced report failure'; END $$;
      CREATE TRIGGER reject_test_report_insert BEFORE INSERT ON reports
      FOR EACH ROW EXECUTE FUNCTION reject_test_report()`);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await database.query(`UPDATE report_generation_jobs SET available_at = now()
        WHERE interview_id = $1`, [interviewId]);
      await rpc(database, "authenti8_process_reports");
    }
    const interview = await database.query<{ status: string }>(
      "SELECT status FROM interviews WHERE id = $1", [interviewId]);
    assert.equal(interview.rows[0]?.status, "FAILED");
    const observed = await database.query<{ count: number }>(`SELECT count(*)::INTEGER count FROM
      operational_failures WHERE component = 'REPORT_QUEUE' AND interview_id = $1`, [interviewId]);
    assert.equal(observed.rows[0]!.count, 1);
  } finally { await database.close(); }
});
test("platform admin changes require a reason, a second administrator, and immutable audit", async () => {
  const fixture = await reportingFixture();
  try {
    const users = await fixture.database.query<{ id: string }>(
      "SELECT id FROM users ORDER BY created_at");
    const requester = users.rows[0]!.id;
    const approver = users.rows[1]!.id;
    await fixture.database.query(
      "INSERT INTO platform_administrators(user_id) VALUES ($1),($2)", [requester, approver]);
    const denied = await rpc<{ created: boolean }>(fixture.database,
      "authenti8_request_admin_change", { userId: requester, action: "REFUND_CREDITS",
        targetId: fixture.organizationId, reason: "short", payload: { amount: 2 } });
    assert.equal(denied.created, false);
    const requested = await rpc<{ created: boolean; requestId: string }>(fixture.database,
      "authenti8_request_admin_change", { userId: requester, action: "REFUND_CREDITS",
        targetId: fixture.organizationId, reason: "Correct a verified billing refund",
        payload: { amount: 2 } });
    assert.equal(requested.created, true);
    const selfApproval = await rpc<{ applied: boolean; reason: string }>(fixture.database,
      "authenti8_approve_admin_change", { userId: requester, requestId: requested.requestId });
    assert.deepEqual(selfApproval, { applied: false, reason: "SECOND_ADMIN_REQUIRED" });
    const approved = await rpc<{ applied: boolean }>(fixture.database,
      "authenti8_approve_admin_change", { userId: approver, requestId: requested.requestId });
    assert.equal(approved.applied, true);
    const audit = await fixture.database.query<{ count: number }>(`SELECT count(*)::INTEGER count
      FROM audit_logs WHERE action = 'REFUND_CREDITS' AND previous_value IS NOT NULL
        AND new_value IS NOT NULL`);
    assert.equal(audit.rows[0]!.count, 1);
    const dispute = await exerciseDisputeReview(fixture, requester);
    assert.equal(dispute.reviewed.updated, true);
    assert.equal(dispute.overview.disputes.find((item) => item.id === dispute.disputeId)?.status,
      "REVIEWED");
    assert.equal(dispute.overview.organizations.find((item) => item.id === fixture.organizationId)
      ?.openDisputes, 1);
    assert.equal(dispute.resolved.updated, true);
    assert.equal(dispute.auditCount, 1);
    await assert.rejects(fixture.database.query("UPDATE audit_logs SET reason = 'changed'"));
  } finally { await fixture.database.close(); }
});
test("retention anonymizes identity, removes evidence, and blocks report access", async () => {
  const fixture = await reportingFixture();
  try {
    const interviewId = await insertInterview(fixture.database, fixture.organizationId,
      "Expired Candidate", "expired@candidate.test", new Date(Date.now() - 120_000),
      "MEETING_COMPLETED");
    const sessionId = await seedCandidateIdentity(fixture.database, interviewId);
    await fixture.database.query(`INSERT INTO candidate_disputes(interview_id,reason)
      VALUES ($1,'Personal dispute details')`, [interviewId]);
    const report = await fixture.database.query<{ id: string }>(`INSERT INTO reports(interview_id, detection_result, monitoring_status, coverage_percentage, snapshot)
      VALUES ($1,'NONE','COMPLETED',100,'{}') RETURNING id`, [interviewId]);
    await fixture.database.query(`UPDATE interviews SET report_id = $2,
      report_due_at = now() - interval '1 second', deletion_due_at = now() - interval '1 second'
      WHERE id = $1`, [interviewId, report.rows[0]!.id]);
    const result = await rpc<{ processed: number }>(fixture.database, "authenti8_run_retention");
    assert.equal(result.processed, 1);
    const row = await fixture.database.query<{ email: string; deleted: boolean }>(`SELECT
      candidate_email email, data_deleted_at IS NOT NULL deleted FROM interviews WHERE id = $1`,
    [interviewId]);
    assert.match(row.rows[0]!.email, /^deleted\+/);
    assert.equal(row.rows[0]!.deleted, true);
    const leaked = await fixture.database.query<{ count: number }>(`SELECT
      (SELECT count(*) FROM verification_sessions WHERE interview_id = $1
        AND candidate_email = 'expired@candidate.test')
      + (SELECT count(*) FROM candidate_verification_tokens WHERE interview_id = $1
        AND candidate_email = 'expired@candidate.test')
      + (SELECT count(*) FROM candidate_consents WHERE interview_id = $1
        AND (candidate_email = 'expired@candidate.test' OR ip_address IS NOT NULL
          OR user_agent IS NOT NULL))
      + (SELECT count(*) FROM interview_participants WHERE interview_id = $1 AND is_external)
      + (SELECT count(*) FROM candidate_devices WHERE verification_session_id = $2)
      + (SELECT count(*) FROM candidate_disputes WHERE interview_id = $1) count`,
    [interviewId, sessionId]);
    assert.equal(Number(leaked.rows[0]!.count), 0);
    const reports = await fixture.database.query("SELECT id FROM reports WHERE interview_id = $1", [interviewId]);
    assert.equal(reports.rows.length, 0);
    const detail = await rpc(fixture.database, "authenti8_meeting_detail",
      { userId: fixture.userId, interviewId });
    assert.equal(detail, null);
  } finally { await fixture.database.close(); }
});
test("accuracy results block false positives and operational failures back off", async () => {
  const fixture = await reportingFixture();
  try {
    const interviewId = randomUUID();
    await insertInterview(fixture.database, fixture.organizationId, "Recovery Candidate",
      "recovery@candidate.test", new Date(), "MEETING_COMPLETED", interviewId);
    const failed = await rpc<{ passed: boolean; falsePositives: number }>(fixture.database,
      "authenti8_record_accuracy_run", { platform: "WINDOWS", osVersion: "Windows 11",
        agentVersion: "1.0.0", rulePackVersion: "pack-1", commitSha: "abc",
        artifactDigest: "a".repeat(64), attestationDigest: "1".repeat(64),
        evidenceSource: "NATIVE_E2E", attestationProvider: "HMAC_SHA256",
        scenarioContractVersion: "pilot-v1",
        scenarios: accuracyScenarios("WINDOWS", "google-meet", "CONFIRMED") });
    assert.equal(failed.passed, false);
    assert.equal(failed.falsePositives, 1);
    await assertTamperedAccuracyRejected(fixture.database);
    const recordedId = await assertOperationalFailureRecovery(fixture, interviewId);
    const queued = await fixture.database.query<{ count: number }>(`SELECT count(*) FROM report_generation_jobs
      WHERE interview_id = $1 AND status = 'PENDING'`, [interviewId]);
    assert.equal(Number(queued.rows[0]!.count), 1);
    await rpc(fixture.database, "authenti8_process_reports");
    const done = await fixture.database.query<{ status: string }>(
      "SELECT status FROM operational_failures WHERE id = $1", [recordedId]);
    assert.equal(done.rows[0]!.status, "RESOLVED");
  } finally { await fixture.database.close(); }
});
test("pilot accuracy is bound to the exact production agent, commit, and active pack", async () => {
  const fixture = await reportingFixture();
  try {
    await fixture.database.query("INSERT INTO platform_administrators(user_id) VALUES ($1)",
      [fixture.userId]);
    await configureUnrelatedPilotCalendar(fixture);
    for (const [platform, version] of [["WINDOWS", "win-pack"], ["MACOS", "mac-pack"],
      ["CHROME", "chrome-pack"]]) {
      await fixture.database.query(`INSERT INTO detection_rule_packs(platform, version, rules,
        signed_payload, signature, expires_at, published_by) VALUES
        ($1,$2,'[]','{}','signature',now()+interval '1 day',$3)`,
      [platform, version, fixture.userId]);
    }
    await registerPilotAgents(fixture);
    const windowsScenarios = accuracyScenarios("WINDOWS");
    await rpc(fixture.database, "authenti8_record_accuracy_run", { platform: "WINDOWS",
      osVersion: "Windows 11", agentVersion: "1.0.0", rulePackVersion: "win-pack",
      commitSha: "win-old", artifactDigest: "b".repeat(64),
      attestationDigest: "2".repeat(64), evidenceSource: "NATIVE_E2E",
      attestationProvider: "HMAC_SHA256", scenarioContractVersion: "pilot-v1",
      scenarios: windowsScenarios });
    await rpc(fixture.database, "authenti8_record_accuracy_run", { platform: "MACOS",
      osVersion: "macOS 15", agentVersion: "2.0.0", rulePackVersion: "mac-pack",
      commitSha: "mac-current", artifactDigest: "c".repeat(64),
      attestationDigest: "3".repeat(64), evidenceSource: "NATIVE_E2E",
      attestationProvider: "HMAC_SHA256", scenarioContractVersion: "pilot-v1",
      scenarios: accuracyScenarios("MACOS") });
    const stale = await rpc<{ checks: Array<{ key: string; passed: boolean }> }>(fixture.database,
      "authenti8_pilot_readiness", { userId: fixture.userId });
    assert.equal(stale.checks.find((check) => check.key === "accuracy-windows")?.passed, false);
    await assertWrongArtifactBlocked(fixture, windowsScenarios);
    await rpc(fixture.database, "authenti8_record_accuracy_run", { platform: "WINDOWS",
      osVersion: "Windows 11", agentVersion: "2.0.0", rulePackVersion: "win-pack",
      commitSha: "win-current", artifactDigest: "d".repeat(64),
      attestationDigest: "4".repeat(64), evidenceSource: "NATIVE_E2E",
      attestationProvider: "HMAC_SHA256", scenarioContractVersion: "pilot-v1",
      scenarios: windowsScenarios });
    const current = await rpc<{ checks: Array<{ key: string; passed: boolean }> }>(fixture.database,
      "authenti8_pilot_readiness", { userId: fixture.userId });
    assert.equal(current.checks.find((check) => check.key === "accuracy-windows")?.passed, true);
    assert.equal(current.checks.find((check) => check.key === "accuracy-macos")?.passed, true);
    const conflict = await rpc<{ registered: boolean; reason?: string }>(fixture.database,
      "authenti8_register_application_version", { application: "WINDOWS_AGENT",
        platform: "WINDOWS", version: "2.0.0", releaseChannel: "PRODUCTION",
        minimumSupported: true, commitSha: "different-build", artifactDigest: "d".repeat(64) });
    assert.deepEqual(conflict, { registered: false, reason: "VERSION_COMMIT_CONFLICT" });
    await assertPilotCalendarScope(fixture, current);
  } finally { await fixture.database.close(); }
});
type MeetingsPage = { items: Array<{ candidateEmail: string }>; nextCursor: string | null };
async function registerPilotAgents(fixture: ReportingFixture) {
  for (const input of [
    { application: "WINDOWS_AGENT", platform: "WINDOWS", version: "2.0.0",
      releaseChannel: "PRODUCTION", minimumSupported: true, commitSha: "win-current",
      artifactDigest: "d".repeat(64) },
    { application: "MACOS_AGENT", platform: "MACOS", version: "2.0.0",
      releaseChannel: "PRODUCTION", minimumSupported: true, commitSha: "mac-current",
      artifactDigest: "c".repeat(64) },
  ]) await rpc(fixture.database, "authenti8_register_application_version", input);
}
async function assertWrongArtifactBlocked(fixture: ReportingFixture,
  scenarios: ReturnType<typeof accuracyScenarios>) {
  await rpc(fixture.database, "authenti8_record_accuracy_run", { platform: "WINDOWS",
    osVersion: "Windows 11", agentVersion: "2.0.0", rulePackVersion: "win-pack",
    commitSha: "win-current", artifactDigest: "e".repeat(64),
    attestationDigest: "5".repeat(64), evidenceSource: "NATIVE_E2E",
    attestationProvider: "HMAC_SHA256", scenarioContractVersion: "pilot-v1", scenarios });
  const readiness = await rpc<{ checks: Array<{ key: string; passed: boolean }> }>(fixture.database,
    "authenti8_pilot_readiness", { userId: fixture.userId });
  assert.equal(readiness.checks.find((item) => item.key === "accuracy-windows")?.passed, false);
}
async function assertOperationalFailureRecovery(fixture: ReportingFixture, interviewId: string) {
  const recorded = await rpc<{ id: string }>(fixture.database,
    "authenti8_record_operational_failure", { component: "REPORT_QUEUE",
      organizationId: fixture.organizationId, interviewId,
      idempotencyKey: "report-queue:test", errorCode: "TIMEOUT",
      safeMessage: "Report worker failed Authorization=Bearer exposed-secret token=raw-token",
      context: { token: "must-not-persist", sessionToken: "session-secret", queueDelayMs: 1000,
        upstreamError: "request failed token=scalar-secret",
        request: { Authorization: "Bearer nested-secret", api_key: "nested-key" } } });
  const recovery = await rpc<{ retriesScheduled: number }>(fixture.database,
    "authenti8_recover_operations");
  assert.equal(recovery.retriesScheduled, 1);
  const context = await fixture.database.query<{ value: { token: string; sessionToken: string;
    request: { Authorization: string; api_key: string } }; message: string; status: string }>(
    `SELECT context value,safe_message message,status FROM operational_failures WHERE id = $1`,
    [recorded.id]);
  assert.deepEqual(context.rows[0]!.value, { token: "[REDACTED]", sessionToken: "[REDACTED]",
    queueDelayMs: 1000, upstreamError: "request failed token=[REDACTED]",
    request: { Authorization: "[REDACTED]", api_key: "[REDACTED]" } });
  assert.doesNotMatch(context.rows[0]!.message, /exposed-secret|raw-token/);
  assert.equal(context.rows[0]!.status, "RETRYING");
  const leased = await fixture.database.query<{ lease: string; available: string }>(
    `SELECT lease_until::TEXT lease,available_at::TEXT available
      FROM operational_failures WHERE id = $1`, [recorded.id]);
  await rpc(fixture.database, "authenti8_record_operational_failure", { component: "REPORT_QUEUE",
    organizationId: fixture.organizationId, interviewId, idempotencyKey: "report-queue:test",
    errorCode: "TIMEOUT", safeMessage: "Duplicate report failure" });
  const preserved = await fixture.database.query<{ status: string; lease: string; available: string }>(
    `SELECT status,lease_until::TEXT lease,available_at::TEXT available
      FROM operational_failures WHERE id = $1`, [recorded.id]);
  assert.deepEqual(preserved.rows[0], { status: "RETRYING", lease: leased.rows[0]!.lease,
    available: leased.rows[0]!.available });
  return recorded.id;
}
function accuracyScenarios(platform: "WINDOWS" | "MACOS", changedId?: string,
  changedActual?: "CONFIRMED" | "NOT_DETECTED") {
  const positive = platform === "WINDOWS" ? ["cluely-active", "parakeet-active",
    "supported-extension-active", "hidden-overlay", "capture-excluded-overlay", "virtual-audio-ai"]
    : ["cluely-active", "parakeet-active", "hidden-overlay", "virtual-audio-ai"];
  const negative = platform === "WINDOWS" ? ["google-meet", "slack-teams-zoom", "notion-vscode",
    "recorders-password-managers", "accessibility-noise-removal", "benign-virtual-audio"]
    : ["meet-slack-teams-zoom", "notion-vscode", "recorders-password-managers",
      "accessibility-noise-removal", "benign-virtual-audio"];
  const scenario = (id: string, expected: "CONFIRMED" | "NOT_DETECTED") => ({ id, expected,
    actual: id === changedId ? changedActual : expected, coverageHealthy: true });
  return [...positive.map((id) => scenario(id, "CONFIRMED")), ...negative.map((id) =>
    scenario(id, "NOT_DETECTED"))];
}
async function assertTamperedAccuracyRejected(database: PGlite) {
  const scenarios = accuracyScenarios("WINDOWS"); scenarios[0]!.expected = "NOT_DETECTED";
  const result = await rpc<{ recorded: boolean; reason: string }>(database, "authenti8_record_accuracy_run", { platform: "WINDOWS", osVersion: "Windows 11", agentVersion: "tampered", rulePackVersion: "pack-1", commitSha: "tampered", artifactDigest: "f".repeat(64), attestationDigest: "6".repeat(64), evidenceSource: "NATIVE_E2E", attestationProvider: "HMAC_SHA256", scenarioContractVersion: "pilot-v1", scenarios });
  assert.deepEqual(result, { recorded: false, reason: "INCOMPLETE_SCENARIO_SET" });
}
async function configureUnrelatedPilotCalendar(fixture: ReportingFixture) {
  await fixture.database.query(`INSERT INTO pilot_partners(organization_id, enabled_by)
    VALUES ($1,$2)`, [fixture.organizationId, fixture.userId]);
  await insertGoogleIntegration(fixture, fixture.otherOrganizationId, "unrelated-calendar");
}
async function assertPilotCalendarScope(fixture: ReportingFixture,
  readiness: { checks: Array<{ key: string; passed: boolean }> }) {
  assert.equal(readiness.checks.find((check) => check.key === "calendar-connected")?.passed, false);
  await insertGoogleIntegration(fixture, fixture.organizationId, "pilot-calendar");
  const connected = await rpc<typeof readiness>(fixture.database,
    "authenti8_pilot_readiness", { userId: fixture.userId });
  assert.equal(connected.checks.find((check) => check.key === "calendar-connected")?.passed, true);
  const interviewId = await insertInterview(fixture.database, fixture.organizationId,
    "Dead Letter Candidate", "dead-letter@candidate.test", new Date(), "MEETING_COMPLETED");
  await fixture.database.query(`INSERT INTO report_generation_jobs(interview_id, status, attempts, available_at)
    VALUES ($1,'FAILED',5,now())`, [interviewId]);
  const blocked = await rpc<typeof readiness>(fixture.database,
    "authenti8_pilot_readiness", { userId: fixture.userId });
  assert.equal(blocked.checks.find((check) => check.key === "no-open-dead-letters")?.passed, false);
}
function insertGoogleIntegration(fixture: ReportingFixture, organizationId: string, subject: string) {
  return fixture.database.query(`INSERT INTO google_integrations(organization_id,
    connected_user_id, google_subject, connected_email, encrypted_refresh_token, status)
    VALUES ($1,$2,$3,'calendar@pilot.test','encrypted','ACTIVE')`,
  [organizationId, fixture.userId, subject]);
}
