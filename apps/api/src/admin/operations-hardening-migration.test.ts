import assert from "node:assert/strict";
import test from "node:test";
import { insertInterview, reportingFixture, rpc } from
  "../interviews/reporting-migration.helper.js";

test("operational idempotency cannot cross targets and terminal completion is audited", async () => {
  const fixture = await reportingFixture();
  try {
    const first = await insertInterview(fixture.database, fixture.organizationId,
      "First Candidate", "first@candidate.test", new Date());
    const second = await insertInterview(fixture.database, fixture.organizationId,
      "Second Candidate", "second@candidate.test", new Date());
    const recorded = await recordFailure(fixture, first);
    const collision = await recordFailure(fixture, second);
    assert.deepEqual(collision, { recorded: false, reason: "IDEMPOTENCY_CONFLICT" });
    await fixture.database.query(`UPDATE operational_failures SET status = 'RETRYING', attempts = 5
      WHERE id = $1`, [recorded.id]);
    const completed = await rpc<{ updated: boolean }>(fixture.database,
      "authenti8_complete_operational_failure", { id: recorded.id, success: false,
        safeMessage: "Still unavailable" });
    assert.equal(completed.updated, true);
    const audit = await fixture.database.query<{ count: number }>(`SELECT count(*)::INTEGER count
      FROM audit_logs WHERE action = 'OPERATION_DEAD_LETTERED' AND target_id = $1`, [recorded.id]);
    assert.equal(audit.rows[0]!.count, 1);
  } finally { await fixture.database.close(); }
});

test("operational failures enforce tenant ownership and observational recovery", async () => {
  const fixture = await reportingFixture();
  try {
    const interviewId = await insertInterview(fixture.database, fixture.organizationId,
      "Observed Candidate", "observed@candidate.test", new Date());
    const mismatch = await rpc<{ recorded: boolean; reason: string }>(fixture.database,
      "authenti8_record_operational_failure", { component: "LIVE_STREAM",
        organizationId: fixture.otherOrganizationId, interviewId, idempotencyKey: "tenant-mismatch",
        errorCode: "POLL_FAILED", safeMessage: "Live polling failed" });
    assert.deepEqual(mismatch, { recorded: false, reason: "INVALID_FAILURE" });
    const recorded = await rpc<{ recorded: boolean; id: string }>(fixture.database,
      "authenti8_record_operational_failure", { component: "LIVE_STREAM", interviewId,
        idempotencyKey: "stable-live-stream", errorCode: "POLL_FAILED",
        safeMessage: "Live polling failed" });
    assert.equal(recorded.recorded, true);
    const linked = await fixture.database.query<{ organizationId: string }>(`SELECT
      organization_id "organizationId" FROM operational_failures WHERE id = $1`, [recorded.id]);
    assert.equal(linked.rows[0]!.organizationId, fixture.organizationId);
    await rpc(fixture.database, "authenti8_recover_operations");
    let state = await fixture.database.query<{ status: string }>(
      "SELECT status FROM operational_failures WHERE id = $1", [recorded.id]);
    assert.equal(state.rows[0]!.status, "OPEN");
    await fixture.database.query(`UPDATE operational_failures SET last_seen_at =
      now() - interval '6 minutes', available_at = now() WHERE id = $1`, [recorded.id]);
    await rpc(fixture.database, "authenti8_recover_operations");
    state = await fixture.database.query<{ status: string }>(
      "SELECT status FROM operational_failures WHERE id = $1", [recorded.id]);
    assert.equal(state.rows[0]!.status, "RESOLVED");
  } finally { await fixture.database.close(); }
});

test("approved administrative refunds restore usable interview credits", async () => {
  const fixture = await reportingFixture();
  try {
    const users = await fixture.database.query<{ id: string }>("SELECT id FROM users ORDER BY created_at");
    await fixture.database.query("INSERT INTO platform_administrators(user_id) VALUES ($1),($2)",
      [users.rows[0]!.id, users.rows[1]!.id]);
    const before = await usableCredits(fixture);
    const requested = await rpc<{ created: boolean; requestId: string }>(fixture.database,
      "authenti8_request_admin_change", { userId: users.rows[0]!.id, action: "REFUND_CREDITS",
        targetId: fixture.organizationId, reason: "Restore two incorrectly consumed credits",
        payload: { amount: 2 } });
    assert.equal(requested.created, true);
    const approved = await rpc<{ applied: boolean }>(fixture.database,
      "authenti8_approve_admin_change", { userId: users.rows[1]!.id,
        requestId: requested.requestId });
    assert.equal(approved.applied, true);
    assert.equal(await usableCredits(fixture), before + 2);
  } finally { await fixture.database.close(); }
});

test("approving a refund for a missing organization returns a domain failure", async () => {
  const fixture = await reportingFixture();
  try {
    const users = await fixture.database.query<{ id: string }>("SELECT id FROM users ORDER BY created_at");
    await fixture.database.query("INSERT INTO platform_administrators(user_id) VALUES ($1),($2)",
      [users.rows[0]!.id, users.rows[1]!.id]);
    const missingOrganization = "00000000-0000-4000-8000-000000000099";
    const requested = await rpc<{ created: boolean; requestId: string }>(fixture.database,
      "authenti8_request_admin_change", { userId: users.rows[0]!.id, action: "REFUND_CREDITS",
        targetId: missingOrganization, reason: "Restore credits to a removed organization",
        payload: { amount: 2 } });
    assert.equal(requested.created, true);
    const approved = await rpc<{ applied: boolean; reason: string }>(fixture.database,
      "authenti8_approve_admin_change", { userId: users.rows[1]!.id,
        requestId: requested.requestId });
    assert.deepEqual(approved, { applied: false, reason: "TARGET_UNAVAILABLE" });
  } finally { await fixture.database.close(); }
});

test("report recovery restores the lifecycle before retrying an exhausted job", async () => {
  const fixture = await reportingFixture();
  try {
    const interviewId = await insertInterview(fixture.database, fixture.organizationId,
      "Retry Candidate", "retry@candidate.test", new Date(), "REPORT_PROCESSING");
    await fixture.database.query(`INSERT INTO report_generation_jobs(interview_id, status,
      attempts, last_error, available_at) VALUES ($1,'PENDING',4,'timeout',now())`, [interviewId]);
    await fixture.database.query(`UPDATE report_generation_jobs SET status='FAILED', attempts=5
      WHERE interview_id=$1`, [interviewId]);
    const failure = await rpc<{ id: string }>(fixture.database,
      "authenti8_record_operational_failure", { component: "REPORT_QUEUE",
        organizationId: fixture.organizationId, interviewId, idempotencyKey: "exhausted-report",
        errorCode: "REPORT_FAILED", safeMessage: "Report generation exhausted" });
    await rpc(fixture.database, "authenti8_recover_operations");
    const state = await fixture.database.query<{ interview: string; job: string; attempts: number }>(
      `SELECT interview.status interview,job.status job,job.attempts FROM interviews interview
      JOIN report_generation_jobs job ON job.interview_id=interview.id WHERE interview.id=$1`,
    [interviewId]);
    assert.deepEqual(state.rows[0], { interview: "MEETING_COMPLETED", job: "PENDING", attempts: 0 });
    const audit = await fixture.database.query<{ count: number }>(`SELECT count(*)::INTEGER count
      FROM interview_lifecycle_events WHERE interview_id=$1 AND from_status='FAILED'
      AND to_status='MEETING_COMPLETED' AND reason='REPORT_REGENERATION_REQUESTED'`, [interviewId]);
    assert.equal(audit.rows[0]!.count, 1);
    assert.ok(failure.id);
  } finally { await fixture.database.close(); }
});

test("calendar recovery replaces a stale connection generation", async () => {
  const fixture = await reportingFixture();
  try {
    const integration = await fixture.database.query<{ id: string }>(`INSERT INTO
      google_integrations(organization_id, connected_user_id, google_subject, connected_email,
        encrypted_refresh_token, status)
      VALUES ($1,$2,'calendar-recovery','calendar@recovery.test','encrypted','ACTIVE')
      RETURNING id`, [fixture.organizationId, fixture.userId]);
    const integrationId = integration.rows[0]!.id;
    await fixture.database.query(`INSERT INTO calendar_sync_jobs(google_integration_id,
      connection_generation, attempt_count) VALUES ($1,1,5)`, [integrationId]);
    await fixture.database.query(`UPDATE google_integrations SET connection_generation = 2
      WHERE id = $1`, [integrationId]);
    const failure = await rpc<{ recorded: boolean; id: string }>(fixture.database,
      "authenti8_record_operational_failure", { component: "CALENDAR_WEBHOOK",
        organizationId: fixture.organizationId, idempotencyKey: "calendar-generation-recovery",
        errorCode: "SYNC_FAILED", safeMessage: "Calendar synchronization failed",
        context: { googleIntegrationId: integrationId } });
    assert.equal(failure.recorded, true);
    const scheduled = await fixture.database.query<{ scheduled: boolean }>(
      "SELECT authenti8_schedule_operational_retry($1) scheduled", [failure.id]);
    assert.equal(scheduled.rows[0]!.scheduled, true);
    const job = await fixture.database.query<{ generation: number; attempts: number }>(`SELECT
      connection_generation::INTEGER generation,attempt_count::INTEGER attempts
      FROM calendar_sync_jobs WHERE google_integration_id = $1`, [integrationId]);
    assert.deepEqual(job.rows[0], { generation: 2, attempts: 0 });
  } finally { await fixture.database.close(); }
});

test("calendar recovery does not retry an integration awaiting reauthentication", async () => {
  const fixture = await reportingFixture();
  try {
    const integration = await fixture.database.query<{ id: string }>(`INSERT INTO
      google_integrations(organization_id, connected_user_id, google_subject, connected_email,
        encrypted_refresh_token, status)
      VALUES ($1,$2,'revoked-calendar','revoked@calendar.test','encrypted','REAUTH_REQUIRED')
      RETURNING id`, [fixture.organizationId, fixture.userId]);
    const failure = await rpc<{ id: string }>(fixture.database,
      "authenti8_record_operational_failure", { component: "OAUTH_REFRESH",
        organizationId: fixture.organizationId, idempotencyKey: "revoked-calendar",
        errorCode: "TOKEN_REFRESH_FAILED", safeMessage: "Token refresh failed",
        context: { googleIntegrationId: integration.rows[0]!.id } });
    const scheduled = await fixture.database.query<{ scheduled: boolean }>(
      "SELECT authenti8_schedule_operational_retry($1) scheduled", [failure.id]);
    assert.equal(scheduled.rows[0]!.scheduled, false);
    const jobs = await fixture.database.query("SELECT 1 FROM calendar_sync_jobs");
    assert.equal(jobs.rows.length, 0);
  } finally { await fixture.database.close(); }
});

test("candidates can submit one unresolved dispute with their latest verification token", async () => {
  const fixture = await reportingFixture();
  try {
    const interviewId = await insertInterview(fixture.database, fixture.organizationId,
      "Dispute Candidate", "candidate@dispute.test", new Date(), "MEETING_COMPLETED");
    await fixture.database.query(`INSERT INTO candidate_verification_tokens(interview_id,
      candidate_email,token_hash,expires_at,consumed_at,decision)
      VALUES ($1,'candidate@dispute.test','candidate-dispute-token',now()+interval '1 hour',
        now(),'ACCEPTED')`, [interviewId]);
    const first = await rpc<{ submitted: boolean; disputeId: string }>(fixture.database,
      "authenti8_submit_candidate_dispute", { tokenHash: "candidate-dispute-token",
        reason: "The reported detection does not match what happened." });
    assert.equal(first.submitted, true);
    const replay = await rpc<{ submitted: boolean; replayed: boolean; disputeId: string }>(
      fixture.database, "authenti8_submit_candidate_dispute", {
        tokenHash: "candidate-dispute-token", reason: "Submitting the same dispute again." });
    assert.deepEqual(replay, { submitted: true, replayed: true, disputeId: first.disputeId });
    const denied = await rpc<{ submitted: boolean; reason: string }>(fixture.database,
      "authenti8_submit_candidate_dispute", { tokenHash: "unknown-token-value",
        reason: "This token must not authorize access to an interview." });
    assert.deepEqual(denied, { submitted: false, reason: "TOKEN_UNAVAILABLE" });
    await fixture.database.query(`UPDATE candidate_verification_tokens SET
      created_at=now()-interval '2 hours', expires_at=now()-interval '1 hour'
      WHERE token_hash='candidate-dispute-token'`);
    const expired = await rpc<{ submitted: boolean; reason: string }>(fixture.database,
      "authenti8_submit_candidate_dispute", { tokenHash: "candidate-dispute-token",
        reason: "An expired token must not authorize another dispute request." });
    assert.deepEqual(expired, { submitted: false, reason: "TOKEN_UNAVAILABLE" });
  } finally { await fixture.database.close(); }
});

test("retention audits contain no candidate-derived identifier", async () => {
  const fixture = await reportingFixture();
  try {
    const interviewId = await insertInterview(fixture.database, fixture.organizationId,
      "Private Candidate", "private@candidate.test", new Date(), "MEETING_COMPLETED");
    await fixture.database.query(`UPDATE interviews SET evidence_due_at=now()-interval '1 second'
      WHERE id=$1`, [interviewId]);
    await rpc(fixture.database, "authenti8_run_retention");
    const audit = await fixture.database.query<{ value: string }>(`SELECT
      COALESCE(previous_value::TEXT,'') || new_value::TEXT value FROM audit_logs
      WHERE action='RETENTION_APPLIED' AND target_id=$1`, [interviewId]);
    assert.equal(audit.rows.some((entry) => entry.value.includes("private@candidate.test")), false);
    assert.equal(audit.rows.some((entry) => entry.value.includes("candidateEmailHash")), false);
  } finally { await fixture.database.close(); }
});

test("pilot readiness rejects rule packs that are not published yet", async () => {
  const fixture = await reportingFixture();
  try {
    await fixture.database.query("INSERT INTO platform_administrators(user_id) VALUES ($1)",
      [fixture.userId]);
    for (const platform of ["WINDOWS", "MACOS"] as const) {
      await fixture.database.query(`INSERT INTO detection_rule_packs(platform, version, rules,
        signed_payload, signature, expires_at, published_by)
        VALUES ($1,$2,'[]','{}','signature',now()+interval '2 days',$3)`,
      [platform, `${platform.toLowerCase()}-current`, fixture.userId]);
    }
    await fixture.database.query(`INSERT INTO detection_rule_packs(platform, version, rules,
      signed_payload, signature, published_at, expires_at, published_by)
      VALUES ('CHROME','chrome-future','[]','{}','signature',now()+interval '1 day',
        now()+interval '2 days',$1)`, [fixture.userId]);
    const readiness = await rpc<{ checks: Array<{ key: string; passed: boolean }> }>(
      fixture.database, "authenti8_pilot_readiness", { userId: fixture.userId });
    assert.equal(readiness.checks.find((check) => check.key === "active-rule-packs")?.passed,
      false);
  } finally { await fixture.database.close(); }
});

test("accuracy attestations are immutable per release artifact", async () => {
  const fixture = await reportingFixture();
  try {
    const input = accuracyInput("a".repeat(64));
    const first = await rpc<{ recorded: boolean }>(fixture.database,
      "authenti8_record_accuracy_run", input);
    assert.equal(first.recorded, true);
    const exact = await rpc<{ recorded: boolean; falsePositives: number }>(fixture.database,
      "authenti8_record_accuracy_run", accuracyInput("a".repeat(64)));
    assert.equal(exact.recorded, true);
    assert.equal(exact.falsePositives, 0);
    const replay = accuracyInput("a".repeat(64));
    replay.scenarios[0]!.actual = "CONFIRMED";
    replay.attestationDigest = "8".repeat(64);
    const second = await rpc<{ recorded: boolean }>(fixture.database,
      "authenti8_record_accuracy_run", replay);
    assert.deepEqual(second, { recorded: false, reason: "ATTESTATION_CONFLICT" });
    const stored = await fixture.database.query<{ falsePositives: number }>(`SELECT
      false_positives "falsePositives" FROM accuracy_runs WHERE artifact_digest = $1`,
    ["a".repeat(64)]);
    assert.equal(stored.rows[0]!.falsePositives, 0);
  } finally { await fixture.database.close(); }
});

test("matcher fixtures cannot be recorded as native release evidence", async () => {
  const fixture = await reportingFixture();
  try {
    const input = { ...accuracyInput("b".repeat(64)), evidenceSource: "MATCHER_FIXTURE" };
    const result = await rpc<{ recorded: boolean; reason: string }>(fixture.database,
      "authenti8_record_accuracy_run", input);
    assert.deepEqual(result, { recorded: false, reason: "NATIVE_EVIDENCE_REQUIRED" });
  } finally { await fixture.database.close(); }
});

test("accuracy release rolls back every platform when either result is rejected", async () => {
  const fixture = await reportingFixture();
  try {
    const windows = accuracyInput("c".repeat(64));
    const invalidMac = { ...accuracyInput("d".repeat(64)), platform: "MACOS",
      rulePackVersion: "mac-pack", scenarios: [] };
    await insertActivePack(fixture, "WINDOWS", "win-pack");
    await insertActivePack(fixture, "MACOS", "mac-pack");
    const result = await rpc<{ released: boolean; reason: string }>(fixture.database,
      "authenti8_record_accuracy_release", { results: [windows, invalidMac] });
    assert.equal(result.released, false);
    const persisted = await fixture.database.query<{ count: number }>(`SELECT
      (SELECT count(*) FROM accuracy_runs WHERE artifact_digest IN ($1,$2))
      + (SELECT count(*) FROM application_versions WHERE artifact_digest IN ($1,$2)) count`,
    [windows.artifactDigest, invalidMac.artifactDigest]);
    assert.equal(Number(persisted.rows[0]!.count), 0);
  } finally { await fixture.database.close(); }
});

test("accuracy release rejects a result that does not use the active rule pack", async () => {
  const fixture = await reportingFixture();
  try {
    await insertActivePack(fixture, "WINDOWS", "new-win-pack");
    await insertActivePack(fixture, "MACOS", "mac-pack");
    const mac = { ...accuracyInput("f".repeat(64)), platform: "MACOS",
      rulePackVersion: "mac-pack" };
    const result = await rpc<{ released: boolean; reason: string }>(fixture.database,
      "authenti8_record_accuracy_release", { results: [accuracyInput("e".repeat(64)), mac] });
    assert.equal(result.released, false);
    assert.match(result.reason, /ACTIVE_RULE_PACK_REQUIRED/);
  } finally { await fixture.database.close(); }
});

test("accuracy release rejects binaries built from different commits", async () => {
  const fixture = await reportingFixture();
  try {
    await insertActivePack(fixture, "WINDOWS", "win-pack");
    await insertActivePack(fixture, "MACOS", "mac-pack");
    const mac = { ...accuracyInput("1".repeat(64)), platform: "MACOS",
      rulePackVersion: "mac-pack", commitSha: "different-commit" };
    const result = await rpc<{ released: boolean; reason: string }>(fixture.database,
      "authenti8_record_accuracy_release", { results: [accuracyInput("2".repeat(64)), mac] });
    assert.deepEqual(result, { released: false, reason: "COMMIT_SET_MISMATCH" });
    const persisted = await fixture.database.query<{ count: number }>(`SELECT count(*)::INTEGER count
      FROM accuracy_runs WHERE artifact_digest IN ($1,$2)`, ["1".repeat(64), "2".repeat(64)]);
    assert.equal(persisted.rows[0]!.count, 0);
  } finally { await fixture.database.close(); }
});

test("application version registration rejects conflicting immutable artifacts", async () => {
  const fixture = await reportingFixture();
  try {
    const base = { application: "WINDOWS_AGENT", platform: "WINDOWS", version: "9.9.9",
      releaseChannel: "PRODUCTION", minimumSupported: true, commitSha: "first-commit",
      artifactDigest: "3".repeat(64) };
    assert.deepEqual(await rpc(fixture.database, "authenti8_register_application_version", base),
      { registered: true });
    assert.deepEqual(await rpc(fixture.database, "authenti8_register_application_version",
      { ...base, commitSha: "second-commit", artifactDigest: "4".repeat(64) }),
    { registered: false, reason: "VERSION_COMMIT_CONFLICT" });
    const stored = await fixture.database.query<{ commit: string; digest: string; minimum: boolean }>(`SELECT
      source_commit_sha commit,artifact_digest digest,minimum_supported minimum FROM application_versions
      WHERE application='WINDOWS_AGENT' AND platform='WINDOWS' AND version='9.9.9'`);
    assert.deepEqual(stored.rows[0], {
      commit: "first-commit", digest: "3".repeat(64), minimum: true,
    });
  } finally { await fixture.database.close(); }
});

test("every terminal interview state receives a retention schedule", async () => {
  const fixture = await reportingFixture();
  try {
    for (const status of ["CONSENT_DECLINED", "EXCLUDED", "SYNC_FAILED", "NO_CREDITS",
      "SUBSCRIPTION_INACTIVE"] as const) {
      const id = await insertInterview(fixture.database, fixture.organizationId,
        `${status} Candidate`, `${status.toLowerCase()}@candidate.test`, new Date(), status);
      const row = await fixture.database.query<{ scheduled: boolean }>(`SELECT
        evidence_due_at IS NOT NULL AND report_due_at IS NOT NULL
          AND deletion_due_at IS NOT NULL scheduled FROM interviews WHERE id=$1`, [id]);
      assert.equal(row.rows[0]!.scheduled, true, `${status} was not scheduled for retention`);
    }
  } finally { await fixture.database.close(); }
});

function recordFailure(fixture: Awaited<ReturnType<typeof reportingFixture>>, interviewId: string) {
  return rpc<{ recorded: boolean; reason?: string; id: string }>(fixture.database,
    "authenti8_record_operational_failure", { component: "REPORT_QUEUE",
      organizationId: fixture.organizationId, interviewId, idempotencyKey: "shared-key",
      errorCode: "TIMEOUT", safeMessage: "Report unavailable" });
}

async function usableCredits(fixture: Awaited<ReturnType<typeof reportingFixture>>) {
  const result = await fixture.database.query<{ credits: number }>(
    "SELECT authenti8_available_credits($1)::INTEGER credits", [fixture.organizationId]);
  return result.rows[0]!.credits;
}

function insertActivePack(fixture: Awaited<ReturnType<typeof reportingFixture>>,
  platform: "WINDOWS" | "MACOS", version: string) {
  return fixture.database.query(`INSERT INTO detection_rule_packs(platform, version, rules,
    signed_payload, signature, expires_at, published_by) VALUES ($1,$2,'[]','{}','signature',
    now() + interval '1 day',$3)`, [platform, version, fixture.userId]);
}

function accuracyInput(artifactDigest: string) {
  const positive = new Set(["capture-excluded-overlay", "cluely-active", "hidden-overlay",
    "parakeet-active", "supported-extension-active", "virtual-audio-ai"]);
  const ids = ["accessibility-noise-removal", "benign-virtual-audio",
    "capture-excluded-overlay", "cluely-active", "google-meet", "hidden-overlay",
    "notion-vscode", "parakeet-active", "recorders-password-managers", "slack-teams-zoom",
    "supported-extension-active", "virtual-audio-ai"];
  return { platform: "WINDOWS", osVersion: "Windows 11", agentVersion: "2.0.0",
    rulePackVersion: "win-pack", commitSha: "same-commit", artifactDigest,
    attestationDigest: "7".repeat(64), evidenceSource: "NATIVE_E2E",
    attestationProvider: "HMAC_SHA256", scenarioContractVersion: "pilot-v1",
    scenarios: ids.map((id) => ({ id, expected: positive.has(id) ? "CONFIRMED" : "NOT_DETECTED",
      actual: positive.has(id) ? "CONFIRMED" : "NOT_DETECTED", coverageHealthy: true })) };
}
