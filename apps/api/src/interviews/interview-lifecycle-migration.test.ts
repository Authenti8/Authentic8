import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
test("interviews are protected, delivered, consented, and audited atomically", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const fixture = await createFixture(database);
    const interviewId = await createInterview(database, fixture.organizationId, "accepted-event");
    const orchestration = await rpc<{ protected: number; scheduled: number }>(
      database, "authenti8_orchestrate_interviews", {},
    );
    assert.deepEqual(orchestration, { protected: 1, scheduled: 1 });
    await database.query("SELECT authenti8_reconcile_entitlement($1)", [fixture.organizationId]);
    assert.equal(await reservationStatus(database, interviewId), "RESERVED");
    const job = await claim(database);
    assert.equal(job.interviewId, interviewId);
    await complete(database, job, "accepted-token-hash");
    const verification = await rpc<{ valid: boolean; consentVersion: string }>(
      database, "authenti8_candidate_verification", { tokenHash: "accepted-token-hash" },
    );
    assert.equal(verification.valid, true);
    assert.deepEqual(await rpc(database, "authenti8_consume_credit", {
      interviewId,
    }), { consumed: false, reason: "INTERVIEW_NOT_ELIGIBLE" });
    const mail = await rpc<{ id: string }>(database, "authenti8_claim_email", {});
    assert.deepEqual(await rpc(database, "authenti8_record_candidate_consent", {
      tokenHash: "accepted-token-hash", decision: "ACCEPTED", consentVersion: "2000-01-01",
    }), { accepted: false, reason: "CONSENT_VERSION_CHANGED" });
    assert.equal((await rpc<{ valid: boolean }>(database, "authenti8_candidate_verification",
      { tokenHash: "accepted-token-hash" })).valid, true);
    const consent = await rpc<{ accepted: boolean; verificationSessionId: string }>(
      database, "authenti8_record_candidate_consent", {
        tokenHash: "accepted-token-hash", decision: "ACCEPTED",
        consentVersion: verification.consentVersion, ipAddress: "127.0.0.1",
        userAgent: "migration-test",
      },
    );
    assert.equal(consent.accepted, true); assert.ok(consent.verificationSessionId);
    assert.equal(await status(database, interviewId), "DEVICE_CONNECTING");
    await assertAmbiguousMailFailurePreservesConsent(database, interviewId, mail.id);
    const activeSession = await database.query<{ status: string; monitoring_started: boolean }>(`SELECT status, monitoring_started_at IS NOT NULL AS monitoring_started FROM verification_sessions WHERE id = $1`, [consent.verificationSessionId]);
    assert.deepEqual(activeSession.rows[0], { status: "MONITORING_ACTIVE", monitoring_started: true });
    assert.deepEqual(await lifecycle(database, interviewId), [
      "DETECTED", "PROTECTED", "VERIFICATION_SCHEDULED",
      "WAITING_FOR_CANDIDATE", "CONSENT_PENDING", "DEVICE_CONNECTING", "MONITORING_ACTIVE",
    ]);
    await assertConsentReplay(database, interviewId, verification.consentVersion, consent);
    await assertEligibilityRevocation(database, fixture);
  } finally {
    await database.close();
  }
});
test("candidate reassignment invalidates the prior candidate link", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const fixture = await createFixture(database);
    const integration = await createIntegration(database, fixture);
    const interviewId = await createInterview(database, fixture.organizationId, "reassigned-event");
    await rpc(database, "authenti8_orchestrate_interviews", {});
    await complete(database, await claim(database), "reassigned-token-hash");
    const schedule = await interviewSchedule(database, interviewId);
    await rpc(database, "authenti8_apply_calendar_sync", {
      integrationId: integration.id, generation: integration.generation, calendarId: "primary",
      events: [{ eventId: "reassigned-event", meetCode: "abc-defg-hij",
        meetUrl: "https://meet.google.com/abc-defg-hij", candidateEmail: "replacement@example.com",
        candidateName: "Replacement", organizerEmail: "owner@lifecycle.test",
        title: "Technical interview", reason: "deterministic test match",
        start: schedule.start, end: schedule.end, updatedAt: new Date().toISOString() }],
      syncToken: "replacement", fullSync: false, syncStartedAt: new Date().toISOString(),
    });
    assert.equal(await status(database, interviewId), "DETECTED");
    assert.equal((await rpc<{ valid: boolean }>(database, "authenti8_candidate_verification",
      { tokenHash: "reassigned-token-hash" })).valid, false);
    assert.equal(await pendingCandidateEmails(database, interviewId), 0);
  } finally {
    await database.close();
  }
});
test("calendar rescheduling moves a pending verification delivery job", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const fixture = await createFixture(database);
    const integration = await createIntegration(database, fixture);
    const interviewId = await createInterview(database, fixture.organizationId, "scheduled-move");
    await rpc(database, "authenti8_orchestrate_interviews", {});
    const start = new Date(Date.now() + 45_000).toISOString();
    const end = new Date(Date.now() + 3_645_000).toISOString();
    await applyCalendarUpdate(database, integration, "scheduled-move", start, end);
    const result = await database.query<{ aligned: boolean; status: string }>(`SELECT
      scheduled_for = $2::timestamptz - interval '1 minute' AS aligned, status
      FROM verification_delivery_jobs WHERE interview_id = $1`, [interviewId, start]);
    assert.deepEqual(result.rows[0], { aligned: true, status: "PENDING" });
  } finally {
    await database.close();
  }
});
test("rescheduling before monitoring rebuilds consent with the new window", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const fixture = await createFixture(database);
    const integration = await createIntegration(database, fixture);
    const interviewId = await createInterview(database, fixture.organizationId, "consented-move");
    await rpc(database, "authenti8_orchestrate_interviews", {});
    const first = await claim(database);
    await complete(database, first, "first-consent-token");
    const verification = await rpc<{ consentVersion: string }>(
      database, "authenti8_candidate_verification", { tokenHash: "first-consent-token" },
    );
    await rpc(database, "authenti8_record_candidate_consent", {
      tokenHash: "first-consent-token", decision: "ACCEPTED",
      consentVersion: verification.consentVersion,
    });
    const start = new Date(Date.now() + 600_000).toISOString();
    const end = new Date(Date.now() + 4_200_000).toISOString();
    await applyCalendarUpdate(database, integration, "consented-move", start, end);
    assert.equal(await status(database, interviewId), "DETECTED");
    const sessions = await database.query<{ status: string }>(
      "SELECT status FROM verification_sessions WHERE interview_id = $1", [interviewId],
    );
    assert.equal(sessions.rows[0]?.status, "CANCELLED");
    assert.deepEqual(await rpc(database, "authenti8_record_candidate_consent", {
      tokenHash: "first-consent-token", decision: "ACCEPTED",
      consentVersion: verification.consentVersion,
    }), { accepted: false, reason: "INTERVIEW_UNAVAILABLE" });
    await rpc(database, "authenti8_orchestrate_interviews", {});
    await database.query("UPDATE verification_delivery_jobs SET available_at = now() WHERE interview_id = $1",
      [interviewId]);
    await complete(database, await claim(database), "second-consent-token");
    const second = await rpc<{ consentVersion: string }>(
      database, "authenti8_candidate_verification", { tokenHash: "second-consent-token" },
    );
    const accepted = await rpc<{ accepted: boolean; verificationSessionId: string }>(
      database, "authenti8_record_candidate_consent", {
      tokenHash: "second-consent-token", decision: "ACCEPTED",
      consentVersion: second.consentVersion,
    });
    assert.equal(accepted.accepted, true);
    assert.match(accepted.verificationSessionId, /^[0-9a-f-]{36}$/);
  } finally {
    await database.close();
  }
});
test("declined consent retains its versioned decision audit context", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const fixture = await createFixture(database);
    const interviewId = await createInterview(database, fixture.organizationId, "declined-event");
    await rpc(database, "authenti8_orchestrate_interviews", {});
    await complete(database, await claim(database), "declined-token-hash");
    const verification = await rpc<{ consentVersion: string }>(database,
      "authenti8_candidate_verification", { tokenHash: "declined-token-hash" });
    assert.deepEqual(await rpc(database, "authenti8_record_candidate_consent", {
      tokenHash: "declined-token-hash", decision: "DECLINED",
      consentVersion: "outdated-version", ipAddress: "127.0.0.2", userAgent: "decline-audit-test",
    }), { accepted: false, reason: "CONSENT_VERSION_CHANGED" });
    assert.equal((await rpc<{ valid: boolean }>(database, "authenti8_candidate_verification",
      { tokenHash: "declined-token-hash" })).valid, true);
    assert.deepEqual(await rpc(database, "authenti8_record_candidate_consent", {
      tokenHash: "declined-token-hash", decision: "DECLINED",
      consentVersion: verification.consentVersion, ipAddress: "127.0.0.2", userAgent: "decline-audit-test",
    }), { accepted: false, declined: true });
    const audit = await database.query<{ decision: string; consent_version: string; no_session: boolean; no_acceptance: boolean; ip_address: string; user_agent: string }>(`SELECT decision,
      consent_version, verification_session_id IS NULL AS no_session, accepted_at IS NULL AS no_acceptance,
      ip_address, user_agent FROM candidate_consents WHERE interview_id = $1`, [interviewId]);
    assert.deepEqual(audit.rows[0], { decision: "DECLINED", consent_version: verification.consentVersion,
      no_session: true, no_acceptance: true, ip_address: "127.0.0.2", user_agent: "decline-audit-test" });
  } finally {
    await database.close();
  }
});
test("expired verification workflows release protection and notify the workspace", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const fixture = await createFixture(database);
    const firstId = await createInterview(database, fixture.organizationId, "expired-consent");
    const secondId = await createInterview(database, fixture.organizationId, "expired-scheduled");
    await rpc(database, "authenti8_orchestrate_interviews", {});
    const delivered = await claim(database);
    await complete(database, delivered, "expired-token");
    const scheduledId = delivered.interviewId === firstId ? secondId : firstId;
    await database.query(`UPDATE interviews SET scheduled_start = now() - interval '2 hours',
      scheduled_end = now() - interval '31 minutes' WHERE id = ANY($1::uuid[])`,
    [[delivered.interviewId, scheduledId]]);
    await rpc(database, "authenti8_orchestrate_interviews", {});
    assert.equal(await status(database, delivered.interviewId), "UNABLE_TO_VERIFY");
    assert.equal(await status(database, scheduledId), "UNABLE_TO_VERIFY");
    assert.equal(await pendingCandidateEmails(database, delivered.interviewId), 0);
    assert.equal((await rpc<{ valid: boolean }>(database, "authenti8_candidate_verification",
      { tokenHash: "expired-token" })).valid, false);
    const state = await database.query<{ released: number; notices: number }>(`SELECT
      (SELECT count(*)::int FROM credit_reservations WHERE interview_id = ANY($1::uuid[])
        AND status = 'RELEASED') AS released,
      (SELECT count(*)::int FROM workspace_notifications WHERE interview_id = ANY($1::uuid[])
        AND kind = 'VERIFICATION_EXPIRED') AS notices`, [[delivered.interviewId, scheduledId]]);
    assert.deepEqual(state.rows[0], { released: 2, notices: 2 });
  } finally {
    await database.close();
  }
});
test("expired device connection releases protection and closes its session", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const fixture = await createFixture(database);
    const interviewId = await createInterview(database, fixture.organizationId, "expired-device");
    await rpc(database, "authenti8_orchestrate_interviews", {});
    await complete(database, await claim(database), "expired-device-token");
    const verification = await rpc<{ consentVersion: string }>(
      database, "authenti8_candidate_verification", { tokenHash: "expired-device-token" },
    );
    await rpc(database, "authenti8_record_candidate_consent", {
      tokenHash: "expired-device-token", decision: "ACCEPTED",
      consentVersion: verification.consentVersion,
    });
    await database.query(`UPDATE interviews SET scheduled_start = now() - interval '2 hours',
      scheduled_end = now() - interval '31 minutes' WHERE id = $1`, [interviewId]);
    await rpc(database, "authenti8_orchestrate_interviews", {});
    assert.equal(await status(database, interviewId), "UNABLE_TO_VERIFY");
    assert.equal(await reservationStatus(database, interviewId), "RELEASED");
    const session = await database.query<{ status: string; closed: boolean }>(`SELECT status,
      monitoring_ended_at IS NOT NULL AS closed FROM verification_sessions
      WHERE interview_id = $1`, [interviewId]);
    assert.deepEqual(session.rows[0], { status: "CANCELLED", closed: true });
  } finally {
    await database.close();
  }
});
test("workspace notifications remain visible until explicitly acknowledged", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const fixture = await createFixture(database);
    await database.query(`INSERT INTO workspace_notifications(organization_id, kind, message,
      idempotency_key) VALUES ($1, 'TEST', 'Needs attention', 'ack-test')`,
    [fixture.organizationId]);
    const before = await rpc<{ notificationCount: number }>(
      database, "authenti8_dashboard_overview", { userId: fixture.userId },
    );
    assert.equal(before.notificationCount, 1);
    assert.deepEqual(await rpc(database, "authenti8_acknowledge_notifications",
      { userId: fixture.userId }), { acknowledged: 1 });
    const after = await rpc<{ notificationCount: number }>(
      database, "authenti8_dashboard_overview", { userId: fixture.userId },
    );
    assert.equal(after.notificationCount, 0);
  } finally {
    await database.close();
  }
});
test("calendar cancellation invalidates pending verification and releases credit", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const fixture = await createFixture(database);
    const integration = await createIntegration(database, fixture);
    const interviewId = await createInterview(database, fixture.organizationId, "cancel-event");
    await rpc(database, "authenti8_orchestrate_interviews", {});
    const job = await claim(database);
    await complete(database, job, "cancel-token-hash");
    assert.equal(await pendingCandidateEmails(database, interviewId), 1);
    const mail = await rpc<{ id: string; attempts: number }>(database, "authenti8_claim_email", {});
    assert.equal(await rpc(database, "authenti8_email_claim_is_deliverable", mail), true);
    await rpc(database, "authenti8_apply_calendar_sync", {
      integrationId: integration.id, generation: integration.generation, calendarId: "primary",
      events: [{ eventId: "cancel-event", cancelled: true,
        updatedAt: new Date(Date.now() + 1000).toISOString() }],
      syncToken: "next", fullSync: false, syncStartedAt: new Date().toISOString(),
    });
    assert.equal(await status(database, interviewId), "CANCELLED");
    assert.equal((await rpc<{ valid: boolean }>(database, "authenti8_candidate_verification",
      { tokenHash: "cancel-token-hash" })).valid, false);
    assert.equal(await pendingCandidateEmails(database, interviewId), 0);
    assert.equal(await rpc(database, "authenti8_email_claim_is_deliverable", mail), false);
    const reservation = await database.query<{ status: string }>(
      "SELECT status FROM credit_reservations WHERE interview_id = $1", [interviewId],
    );
    assert.equal(reservation.rows[0]?.status, "RELEASED");
  } finally {
    await database.close();
  }
});
test("terminal verification delivery failure releases the reserved interview credit", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const fixture = await createFixture(database);
    const interviewId = await createInterview(database, fixture.organizationId, "failed-event");
    await rpc(database, "authenti8_orchestrate_interviews", {});
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const job = await claim(database);
      assert.equal(job.attempts, attempt);
      await rpc(database, "authenti8_fail_verification_delivery", {
        ...job, error: "Permanent delivery failure",
      });
      await database.exec("UPDATE verification_delivery_jobs SET available_at = now()");
    }
    assert.equal(await status(database, interviewId), "UNABLE_TO_VERIFY");
    const state = await database.query<{ reservation: string; protection_status: string }>(`
      SELECT reservation.status AS reservation, interview.protection_status
      FROM interviews interview JOIN credit_reservations reservation
        ON reservation.interview_id = interview.id WHERE interview.id = $1`, [interviewId]);
    assert.deepEqual(state.rows[0], { reservation: "RELEASED", protection_status: "RELEASED" });
  } finally {
    await database.close();
  }
});
test("rescheduling a failed verification rebuilds its protected workflow", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const fixture = await createFixture(database);
    const integration = await createIntegration(database, fixture);
    const interviewId = await createInterview(database, fixture.organizationId, "failed-reschedule");
    await rpc(database, "authenti8_orchestrate_interviews", {});
    await database.query(`SELECT authenti8_transition_interview($1, ARRAY['VERIFICATION_SCHEDULED'],
      'UNABLE_TO_VERIFY', 'VERIFICATION_DELIVERY_FAILED')`, [interviewId]);
    await database.query(`UPDATE credit_reservations SET status = 'RELEASED', released_at = now(),
      release_reason = 'INELIGIBLE' WHERE interview_id = $1`, [interviewId]);
    await database.query("UPDATE interviews SET protection_status = 'RELEASED' WHERE id = $1",
      [interviewId]);
    const start = new Date(Date.now() + 600_000).toISOString();
    const end = new Date(Date.now() + 4_200_000).toISOString();
    await applyCalendarUpdate(database, integration, "failed-reschedule", start, end);
    assert.equal(await status(database, interviewId), "DETECTED");
    assert.equal(await reservationStatus(database, interviewId), "RESERVED");
    await rpc(database, "authenti8_orchestrate_interviews", {});
    assert.equal(await status(database, interviewId), "VERIFICATION_SCHEDULED");
  } finally {
    await database.close();
  }
});
async function createFixture(database: PGlite) {
  await database.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY)");
  await database.exec(loadMigrations());
  const user = await rpc<{ id: string }>(database, "authenti8_create_user", {
    email: "owner@lifecycle.test", fullName: "Lifecycle Owner",
  });
  await database.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [user.id]);
  const result = await rpc<{ organization: { id: string } }>(
    database, "authenti8_create_organization", {
      userId: user.id, name: "Lifecycle", domain: "lifecycle.test",
      jobRole: "FOUNDER", companySize: "1-10", expectedMonthlyInterviews: 0, timezone: "UTC",
    },
  );
  return { userId: user.id, organizationId: result.organization.id };
}

async function createInterview(database: PGlite, organizationId: string, eventId: string) {
  const start = new Date(Date.now() + 30_000).toISOString();
  const end = new Date(Date.now() + 3_630_000).toISOString();
  const result = await database.query<{ id: string }>(`INSERT INTO interviews(
    organization_id, google_event_id, google_calendar_id, google_meet_code, google_meet_url,
    candidate_email, candidate_name, organizer_email, title, classification_reason,
    scheduled_start, scheduled_end) VALUES ($1, $2, 'primary', 'abc-defg-hij',
    'https://meet.google.com/abc-defg-hij', 'candidate@example.com', 'Candidate',
    'owner@lifecycle.test', 'Technical interview', 'deterministic test match', $3, $4)
    RETURNING id`, [organizationId, eventId, start, end]);
  return result.rows[0]!.id;
}
function createIntegration(database: PGlite, fixture: { userId: string; organizationId: string }) {
  return rpc<{ id: string; generation: number }>(database, "authenti8_upsert_google_integration", {
    ...fixture, subject: "subject", email: "owner@lifecycle.test", refreshToken: "encrypted",
    accessToken: "encrypted", expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    calendarId: "primary", calendarName: "Primary",
  });
}
function applyCalendarUpdate(
  database: PGlite, integration: { id: string; generation: number }, eventId: string,
  start: string, end: string,
) {
  return rpc(database, "authenti8_apply_calendar_sync", {
    integrationId: integration.id, generation: integration.generation, calendarId: "primary",
    events: [{ eventId, meetCode: "abc-defg-hij",
      meetUrl: "https://meet.google.com/abc-defg-hij", candidateEmail: "candidate@example.com",
      candidateName: "Candidate", organizerEmail: "owner@lifecycle.test",
      title: "Technical interview", reason: "deterministic test match", start, end,
      updatedAt: new Date(Date.now() + 1_000).toISOString(), participants: [] }],
    syncToken: `sync-${eventId}`, fullSync: false, syncStartedAt: new Date().toISOString(),
  });
}

async function claim(database: PGlite) {
  return rpc<{ interviewId: string; claimToken: string; attempts: number }>(
    database, "authenti8_claim_verification_delivery", {},
  );
}

function complete(
  database: PGlite,
  job: { interviewId: string; claimToken: string; attempts: number },
  tokenHash: string,
) {
  return rpc(database, "authenti8_complete_verification_delivery", { ...job, tokenHash,
    encryptedToken: "encrypted", initializationVector: "iv", authenticationTag: "tag" });
}

async function status(database: PGlite, interviewId: string) {
  const result = await database.query<{ status: string }>(
    "SELECT status FROM interviews WHERE id = $1", [interviewId],
  );
  return result.rows[0]?.status;
}
async function sessionCount(database: PGlite, interviewId: string) {
  const result = await database.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM verification_sessions WHERE interview_id = $1", [interviewId],
  );
  return result.rows[0]?.count;
}

async function pendingCandidateEmails(database: PGlite, interviewId: string) {
  const result = await database.query<{ count: number }>(`SELECT count(*)::int AS count
    FROM auth_email_outbox WHERE interview_id = $1 AND kind = 'candidate_verification'
      AND status IN ('PENDING', 'PROCESSING')`, [interviewId]);
  return result.rows[0]?.count;
}

async function reservationStatus(database: PGlite, interviewId: string) {
  const result = await database.query<{ status: string }>(
    "SELECT status FROM credit_reservations WHERE interview_id = $1", [interviewId],
  );
  return result.rows[0]?.status;
}

async function assertAmbiguousMailFailurePreservesConsent(
  database: PGlite, interviewId: string, mailId: string,
) {
  await database.query("UPDATE auth_email_outbox SET attempts = 5 WHERE id = $1", [mailId]);
  assert.deepEqual(await rpc(database, "authenti8_fail_email", {
    id: mailId, attempts: 5, error: "Ambiguous SMTP completion",
  }), { failed: true, terminal: true });
  assert.equal(await reservationStatus(database, interviewId), "RESERVED");
  assert.deepEqual(await rpc(database, "authenti8_consume_credit", { interviewId }),
    { consumed: true });
  assert.equal(await status(database, interviewId), "MONITORING_ACTIVE");
}

async function assertConsentReplay(
  database: PGlite, interviewId: string, consentVersion: string,
  consent: { accepted: boolean; verificationSessionId: string },
) {
  await database.query(`UPDATE candidate_verification_tokens
    SET expires_at = created_at + interval '1 millisecond' WHERE token_hash = $1`,
  ["accepted-token-hash"]);
  assert.deepEqual(await rpc(database, "authenti8_record_candidate_consent", {
    tokenHash: "accepted-token-hash", decision: "ACCEPTED", consentVersion,
  }), consent);
  assert.deepEqual(await rpc(database, "authenti8_record_candidate_consent", {
    tokenHash: "accepted-token-hash", decision: "DECLINED",
  }), { accepted: false, reason: "CONSENT_DECISION_CONFLICT" });
  assert.equal(await sessionCount(database, interviewId), 1);
}

async function assertEligibilityRevocation(
  database: PGlite, fixture: { organizationId: string },
) {
  const staleId = await createInterview(database, fixture.organizationId, "stale-completion");
  await rpc(database, "authenti8_orchestrate_interviews", {});
  const staleJob = await claim(database);
  await database.query("UPDATE credit_reservations SET status = 'RELEASED' WHERE interview_id = $1", [staleId]);
  assert.deepEqual(await complete(database, staleJob, "stale-token"), { skipped: true });
  assert.equal(await status(database, staleId), "UNABLE_TO_VERIFY");
  const activeId = await createInterview(database, fixture.organizationId, "revoked-active");
  await rpc(database, "authenti8_orchestrate_interviews", {});
  await complete(database, await claim(database), "revoked-token");
  const verification = await rpc<{ consentVersion: string }>(database, "authenti8_candidate_verification", { tokenHash: "revoked-token" });
  await rpc(database, "authenti8_record_candidate_consent", { tokenHash: "revoked-token",
    decision: "ACCEPTED", consentVersion: verification.consentVersion });
  await database.query("UPDATE subscriptions SET status = 'PAST_DUE' WHERE organization_id = $1", [fixture.organizationId]);
  assert.equal(await status(database, activeId), "UNABLE_TO_VERIFY");
  const session = await database.query<{ status: string }>("SELECT status FROM verification_sessions WHERE interview_id = $1", [activeId]);
  assert.equal(session.rows[0]?.status, "CANCELLED");
  assert.equal(await pendingCandidateEmails(database, activeId), 0);
}
async function interviewSchedule(database: PGlite, interviewId: string) {
  const result = await database.query<{ start: string; end: string }>(
    `SELECT scheduled_start::text AS start, scheduled_end::text AS end
      FROM interviews WHERE id = $1`, [interviewId],
  );
  return result.rows[0]!;
}

async function lifecycle(database: PGlite, interviewId: string) {
  const result = await database.query<{ to_status: string }>(
    "SELECT to_status FROM interview_lifecycle_events WHERE interview_id = $1 ORDER BY id",
    [interviewId],
  );
  return result.rows.map((row) => row.to_status);
}

async function rpc<T = unknown>(database: PGlite, name: string, input: object) {
  const result = await database.query<{ value: T }>(
    `SELECT ${name}($1::jsonb) AS value`, [JSON.stringify(input)],
  );
  return result.rows[0]!.value;
}

function loadMigrations() {
  const directory = resolve(process.cwd(), "../../infrastructure/postgres");
  return readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()
    .map((file) => readFileSync(resolve(directory, file), "utf8")).join("\n");
}
