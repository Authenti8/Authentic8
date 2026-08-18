import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { reportingFixture, rpc, type ReportingFixture } from
  "../interviews/reporting-migration.helper.js";

test("every active interviewer owns an isolated Google Calendar connection", async () => {
  const fixture = await reportingFixture();
  try {
    const manager = await addMember(fixture.database, fixture.organizationId,
      "manager@reporting.test", "MANAGER");
    const hr = await addMember(fixture.database, fixture.organizationId,
      "hr@reporting.test", "HR");
    for (const userId of [fixture.userId, manager, hr]) {
      assert.deepEqual(await createState(fixture.database, userId), { created: true });
    }

    const ownerIntegration = await connect(fixture.database, fixture.organizationId,
      fixture.userId, "owner-subject", "owner-calendar", "owner@reporting.test");
    const hrIntegration = await connect(fixture.database, fixture.organizationId,
      hr, "hr-subject", "hr-calendar", "hr.calendar@reporting.test");
    assert.notEqual(ownerIntegration.id, hrIntegration.id);
    const integrations = await fixture.database.query<{ count: number }>(`SELECT
      count(*)::INTEGER count FROM google_integrations WHERE organization_id=$1 AND status='ACTIVE'`,
    [fixture.organizationId]);
    assert.equal(integrations.rows[0]?.count, 2);

    const ownerCredentials = await rpc<{ id: string }>(fixture.database,
      "authenti8_integration_credentials", { userId: fixture.userId });
    const hrCredentials = await rpc<{ id: string }>(fixture.database,
      "authenti8_integration_credentials", { userId: hr });
    assert.equal(ownerCredentials.id, ownerIntegration.id);
    assert.equal(hrCredentials.id, hrIntegration.id);
    const hrSummary = await rpc<{ connectedEmail: string; status: string }>(fixture.database,
      "authenti8_integration_summary", { userId: hr });
    assert.deepEqual(hrSummary, { provider: "GOOGLE_MEET", status: "ACTIVE",
      connectedEmail: "hr.calendar@reporting.test", calendarName: "Primary",
      lastSyncedAt: null, lastErrorCode: null });

    await verifyOwnershipAndIsolation(fixture, manager, hr, ownerIntegration, hrIntegration);
  } finally { await fixture.database.close(); }
});

test("the first iCal sync upgrades an existing provider event without duplicating it", async () => {
  const fixture = await reportingFixture();
  try {
    const integration = await connect(fixture.database, fixture.organizationId,
      fixture.userId, "owner-subject", "owner-calendar", "owner@reporting.test");
    const eventId = randomUUID();
    const legacyId = await syncInterview(fixture.database, integration,
      "owner-calendar", fixture.userId, "", eventId);
    const canonicalKey = `ical:${randomUUID()}@google.com`;
    const upgradedId = await syncInterview(fixture.database, integration,
      "owner-calendar", fixture.userId, canonicalKey, eventId);
    assert.equal(upgradedId, legacyId);
    const result = await fixture.database.query<{ count: number; key: string }>(`SELECT
      count(*)::INTEGER count,max(calendar_event_key) key FROM interviews
      WHERE organization_id=$1`, [fixture.organizationId]);
    assert.deepEqual(result.rows[0], { count: 1, key: canonicalKey });
  } finally { await fixture.database.close(); }
});

test("an advanced HR canonical copy supersedes a legacy Owner duplicate safely", async () => {
  const fixture = await reportingFixture();
  try {
    const hr = await addMember(fixture.database, fixture.organizationId,
      "canonical-first@reporting.test", "HR");
    const owner = await connect(fixture.database, fixture.organizationId,
      fixture.userId, "owner-subject", "owner-calendar", "owner@reporting.test");
    const hrIntegration = await connect(fixture.database, fixture.organizationId,
      hr, "hr-subject", "hr-calendar", "canonical-first@reporting.test");
    const ownerEventId = randomUUID();
    await syncInterview(fixture.database, owner,
      "owner-calendar", fixture.userId, "", ownerEventId);
    const canonicalKey = `ical:${randomUUID()}@google.com`; const canonical = await syncInterview(
      fixture.database, hrIntegration,
      "hr-calendar", fixture.userId, canonicalKey);
    await fixture.database.query("UPDATE interviews SET status='PROTECTED' WHERE id=$1", [canonical]);
    const reconciled = await syncInterview(fixture.database, owner,
      "owner-calendar", fixture.userId, canonicalKey, ownerEventId);
    assert.equal(reconciled, canonical);
    const result = await fixture.database.query<{ active: number; reserved: number; sources: number }>(
      `SELECT count(*) FILTER (WHERE status<>'EXCLUDED')::INTEGER active,
        (SELECT count(*)::INTEGER FROM credit_reservations WHERE status='RESERVED') reserved,
        (SELECT count(*)::INTEGER FROM calendar_interview_sources WHERE interview_id=$1) sources
      FROM interviews WHERE organization_id=$2`, [canonical, fixture.organizationId]);
    assert.deepEqual(result.rows[0], { active: 1, reserved: 1, sources: 2 });
  } finally { await fixture.database.close(); }
});

test("a declined canonical interview supersedes and releases a legacy Owner duplicate", async () => {
  const fixture = await reportingFixture();
  try {
    const hr = await addMember(fixture.database, fixture.organizationId,
      "declined-canonical@reporting.test", "HR");
    const owner = await connect(fixture.database, fixture.organizationId,
      fixture.userId, "owner-subject", "owner-calendar", "owner@reporting.test");
    const hrIntegration = await connect(fixture.database, fixture.organizationId,
      hr, "hr-subject", "hr-calendar", "declined-canonical@reporting.test");
    const ownerEventId = randomUUID(); const legacy = await syncInterview(fixture.database, owner,
      "owner-calendar", fixture.userId, "", ownerEventId);
    const canonicalKey = `ical:${randomUUID()}@google.com`;
    const canonical = await syncInterview(fixture.database, hrIntegration,
      "hr-calendar", fixture.userId, canonicalKey);
    for (const status of ["PROTECTED", "VERIFICATION_SCHEDULED", "WAITING_FOR_CANDIDATE",
      "CONSENT_PENDING", "CONSENT_DECLINED"]) {
      await fixture.database.query("UPDATE interviews SET status=$1 WHERE id=$2", [status, canonical]);
    }

    const reconciled = await syncInterview(fixture.database, owner,
      "owner-calendar", fixture.userId, canonicalKey, ownerEventId);
    assert.equal(reconciled, canonical);
    const result = await fixture.database.query<{ canonicalStatus: string; legacyStatus: string;
      legacyReservation: string; sources: number }>(`SELECT canonical.status "canonicalStatus",
        legacy.status "legacyStatus",reservation.status "legacyReservation",
        (SELECT count(*)::INTEGER FROM calendar_interview_sources
          WHERE interview_id=$1) sources
      FROM interviews canonical JOIN interviews legacy ON legacy.id=$2
      JOIN credit_reservations reservation ON reservation.interview_id=legacy.id
      WHERE canonical.id=$1`, [canonical, legacy]);
    assert.deepEqual(result.rows[0], { canonicalStatus: "CONSENT_DECLINED",
      legacyStatus: "EXCLUDED", legacyReservation: "RELEASED", sources: 2 });
  } finally { await fixture.database.close(); }
});

test("an actively monitored legacy interview supersedes a declined canonical duplicate", async () => {
  const fixture = await reportingFixture();
  try {
    const hr = await addMember(fixture.database, fixture.organizationId,
      "monitored-legacy@reporting.test", "HR");
    const owner = await connect(fixture.database, fixture.organizationId,
      fixture.userId, "owner-subject", "owner-calendar", "owner@reporting.test");
    const hrIntegration = await connect(fixture.database, fixture.organizationId,
      hr, "hr-subject", "hr-calendar", "monitored-legacy@reporting.test");
    const ownerEventId = randomUUID();
    const legacy = await syncInterview(fixture.database, owner,
      "owner-calendar", fixture.userId, "", ownerEventId);
    const canonicalKey = `ical:${randomUUID()}@google.com`;
    const canonical = await syncInterview(fixture.database, hrIntegration,
      "hr-calendar", fixture.userId, canonicalKey);
    for (const status of ["PROTECTED", "VERIFICATION_SCHEDULED", "WAITING_FOR_CANDIDATE",
      "CONSENT_PENDING", "CONSENT_DECLINED"]) {
      await fixture.database.query("UPDATE interviews SET status=$1 WHERE id=$2", [status, canonical]);
    }
    for (const status of ["PROTECTED", "VERIFICATION_SCHEDULED", "WAITING_FOR_CANDIDATE",
      "CONSENT_PENDING", "DEVICE_CONNECTING"]) {
      await fixture.database.query("UPDATE interviews SET status=$1 WHERE id=$2", [status, legacy]);
    }
    await fixture.database.query(`INSERT INTO verification_sessions(interview_id,candidate_email,
      status,consent_version,consented_at,eligible_start,eligible_end)
      SELECT id,candidate_email,'CONSENTED','test-consent',now(),scheduled_start-interval '15 minutes',
        scheduled_end+interval '30 minutes' FROM interviews WHERE id=$1`, [legacy]);
    await fixture.database.query(`UPDATE interviews SET status='MONITORING_ACTIVE',
      monitoring_started_at=now() WHERE id=$1`, [legacy]);

    const reconciled = await syncInterview(fixture.database, owner,
      "owner-calendar", fixture.userId, canonicalKey, ownerEventId);
    assert.equal(reconciled, legacy);
    const result = await fixture.database.query<{ survivorStatus: string; duplicateStatus: string;
      sources: number }>(`SELECT survivor.status "survivorStatus",
        duplicate.status "duplicateStatus",(SELECT count(*)::INTEGER
          FROM calendar_interview_sources WHERE interview_id=$1) sources
      FROM interviews survivor JOIN interviews duplicate ON duplicate.id=$2
      WHERE survivor.id=$1`, [legacy, canonical]);
    assert.deepEqual(result.rows[0], { survivorStatus: "MONITORING_ACTIVE",
      duplicateStatus: "CONSENT_DECLINED", sources: 2 });
  } finally { await fixture.database.close(); }
});

test("a completed canonical report supersedes an actively monitored legacy duplicate", async () => {
  const fixture = await reportingFixture();
  try {
    const hr = await addMember(fixture.database, fixture.organizationId,
      "completed-canonical@reporting.test", "HR"); const manager = await addMember(
      fixture.database, fixture.organizationId, "completed-manager@reporting.test", "MANAGER");
    const owner = await connect(fixture.database, fixture.organizationId,
      fixture.userId, "owner-subject", "owner-calendar", "owner@reporting.test");
    const hrIntegration = await connect(fixture.database, fixture.organizationId,
      hr, "hr-subject", "hr-calendar", "completed-canonical@reporting.test");
    const managerIntegration = await connect(fixture.database, fixture.organizationId,
      manager, "manager-subject", "manager-calendar", "completed-manager@reporting.test");
    const ownerEventId = randomUUID();
    const legacy = await syncInterview(fixture.database, owner,
      "owner-calendar", fixture.userId, "", ownerEventId);
    const canonicalKey = `ical:${randomUUID()}@google.com`;
    const canonical = await syncInterview(fixture.database, hrIntegration,
      "hr-calendar", fixture.userId, canonicalKey);
    await fixture.database.query(`INSERT INTO calendar_interview_sources(
      google_integration_id,provider_event_id,interview_id) VALUES($1,$2,$3)`,
    [managerIntegration.id, randomUUID(), legacy]);
    await advanceToMonitoring(fixture.database, [legacy, canonical]);
    for (const status of ["MEETING_COMPLETED", "REPORT_PROCESSING", "REPORT_READY"]) {
      await fixture.database.query("UPDATE interviews SET status=$1 WHERE id=$2", [status, canonical]);
    }
    const reconciled = await syncInterview(fixture.database, owner,
      "owner-calendar", fixture.userId, canonicalKey, ownerEventId);
    assert.equal(reconciled, canonical);
    const result = await fixture.database.query<{ survivorStatus: string; duplicateStatus: string;
      sources: number; duplicateSources: number }>(`SELECT survivor.status "survivorStatus",
        duplicate.status "duplicateStatus",(SELECT count(*)::INTEGER
          FROM calendar_interview_sources WHERE interview_id=$1) sources,
        (SELECT count(*)::INTEGER FROM calendar_interview_sources
          WHERE interview_id=$2) "duplicateSources"
      FROM interviews survivor JOIN interviews duplicate ON duplicate.id=$2
      WHERE survivor.id=$1`, [canonical, legacy]);
    assert.deepEqual(result.rows[0], { survivorStatus: "REPORT_READY",
      duplicateStatus: "MONITORING_ACTIVE", sources: 3, duplicateSources: 0 });
  } finally { await fixture.database.close(); }
});

async function verifyOwnershipAndIsolation(fixture: ReportingFixture, manager: string, hr: string,
  ownerIntegration: Integration, hrIntegration: Integration) {
  const canonicalKey = `ical:${randomUUID()}@google.com`;
  const newer = new Date(Date.now() + 5_000).toISOString();
  const older = new Date(Date.now() - 5_000).toISOString();
  const ownerEvent = await syncInterview(fixture.database, ownerIntegration,
    "owner-calendar", fixture.userId, canonicalKey, undefined, newer);
  const interviewId = await syncInterview(fixture.database, hrIntegration,
    "hr-calendar", fixture.userId, canonicalKey, undefined, older);
  assert.equal(interviewId, ownerEvent);
  const interview = await fixture.database.query<{ member: string; source: string }>(`SELECT
    responsible_member_user_id member,source_google_integration_id source FROM interviews
    WHERE id=$1`, [interviewId]);
  assert.deepEqual(interview.rows[0], { member: fixture.userId, source: ownerIntegration.id });
  const counts = await fixture.database.query<{ reservations: number; sources: number }>(`SELECT
    (SELECT count(*)::INTEGER FROM credit_reservations WHERE interview_id=$1) reservations,
    (SELECT count(*)::INTEGER FROM calendar_interview_sources WHERE interview_id=$1) sources`,
  [interviewId]);
  assert.deepEqual(counts.rows[0], { reservations: 1, sources: 2 });
  const hrOnly = await syncInterview(fixture.database, hrIntegration,
    "hr-calendar", hr, `ical:${randomUUID()}@google.com`);
  assert.deepEqual(await rpc(fixture.database, "authenti8_disconnect_google", { userId: hr }),
    { disconnected: true });
  const statuses = await fixture.database.query<{ id: string; status: string }>(`SELECT id,status
    FROM google_integrations WHERE organization_id=$1 ORDER BY id`, [fixture.organizationId]);
  assert.equal(statuses.rows.find((row) => row.id === ownerIntegration.id)?.status, "ACTIVE");
  assert.equal(statuses.rows.find((row) => row.id === hrIntegration.id)?.status, "NOT_CONNECTED");
  const stale = await fixture.database.query<{ status: string }>(
    "SELECT status FROM interviews WHERE id=$1", [hrOnly]);
  assert.equal(stale.rows[0]?.status, "EXCLUDED");
  const shared = await fixture.database.query<{ sources: number; status: string }>(`SELECT
    interview.status,(SELECT count(*)::INTEGER FROM calendar_interview_sources source
      WHERE source.interview_id=interview.id) sources FROM interviews interview WHERE id=$1`,
  [interviewId]);
  assert.deepEqual(shared.rows[0], { status: "DETECTED", sources: 1 });
  const managerIntegration = await connect(fixture.database, fixture.organizationId,
    manager, "manager-subject", "manager-calendar", "manager@reporting.test");
  await fixture.database.query(`UPDATE organization_members SET status='SUSPENDED'
    WHERE organization_id=$1 AND user_id=$2`, [fixture.organizationId, manager]);
  const disabled = await fixture.database.query<{ status: string; token: string | null }>(`SELECT
    status,encrypted_access_token token FROM google_integrations WHERE id=$1`,
  [managerIntegration.id]);
  assert.deepEqual(disabled.rows[0], { status: "NOT_CONNECTED", token: null });
  assert.equal(await createState(fixture.database, manager), null);
}

type Integration = { id: string; generation: number };

async function advanceToMonitoring(database: PGlite, interviews: string[]) {
  for (const interview of interviews) {
    for (const status of ["PROTECTED", "VERIFICATION_SCHEDULED", "WAITING_FOR_CANDIDATE",
      "CONSENT_PENDING", "DEVICE_CONNECTING"]) {
      await database.query("UPDATE interviews SET status=$1 WHERE id=$2", [status, interview]);
    }
    await database.query(`INSERT INTO verification_sessions(interview_id,candidate_email,status,
      consent_version,consented_at,eligible_start,eligible_end) SELECT id,candidate_email,
      'CONSENTED','test-consent',now(),scheduled_start-interval '15 minutes',
      scheduled_end+interval '30 minutes' FROM interviews WHERE id=$1`, [interview]);
    await database.query(`UPDATE interviews SET status='MONITORING_ACTIVE',
      monitoring_started_at=now() WHERE id=$1`, [interview]);
  }
}

async function addMember(database: PGlite, organizationId: string, email: string,
  businessRole: "MANAGER" | "HR") {
  const user = await rpc<{ id: string }>(database, "authenti8_create_user", {
    email, fullName: businessRole });
  await database.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [user.id]);
  await database.query(`INSERT INTO organization_members(organization_id,user_id,role,job_role,
    business_role,status) VALUES($1,$2,$3,$4,$4,'ACTIVE')`, [organizationId, user.id,
    businessRole === "MANAGER" ? "ADMIN" : "RECRUITER", businessRole]);
  return user.id;
}

function createState(database: PGlite, userId: string) {
  return rpc<{ created: boolean } | null>(database, "authenti8_create_integration_state", {
    userId, stateHash: randomUUID(), verifier: "verifier",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
}

function connect(database: PGlite, organizationId: string, userId: string, subject: string,
  calendarId: string, email: string) {
  return rpc<{ id: string; generation: number }>(database, "authenti8_upsert_google_integration", {
    organizationId, userId, subject, email, calendarId, calendarName: "Primary",
    accessToken: "access-token", refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
}

async function syncInterview(database: PGlite, integration: Integration, calendarId: string,
  organizerUserId: string, canonicalKey: string, eventId = randomUUID(), updatedAt?: string) {
  const now = Date.now();
  const organizer = await database.query<{ email: string }>(
    "SELECT normalized_email email FROM users WHERE id=$1", [organizerUserId]);
  await rpc(database, "authenti8_apply_calendar_sync", {
    integrationId: integration.id, generation: integration.generation, calendarId,
    syncToken: "sync-token", fullSync: false, syncStartedAt: new Date(now).toISOString(),
    events: [{ eventId, canonicalKey, cancelled: false, meetCode: "abc-defg-hij",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      candidateEmail: "candidate@outside.test", candidateName: "Candidate",
      organizerEmail: organizer.rows[0]!.email, title: "Engineering interview",
      reason: "Test interview", start: new Date(now + 3_600_000).toISOString(),
      end: new Date(now + 5_400_000).toISOString(), updatedAt: updatedAt ?? new Date(now).toISOString(),
      participants: [{ email: "candidate@outside.test", name: "Candidate",
        type: "CANDIDATE", external: true }] }],
  });
  const interview = await database.query<{ id: string }>(
    `SELECT interview_id id FROM calendar_interview_sources
      WHERE google_integration_id=$1 AND provider_event_id=$2`, [integration.id, eventId]);
  return interview.rows[0]!.id;
}
