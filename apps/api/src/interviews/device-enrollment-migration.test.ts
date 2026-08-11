import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test("device enrollment is expiring, single-use, and limited to one active device", async () => {
  const database = await fixture();
  try {
    const enrollmentToken = "e".repeat(64);
    const prepared = await prepare(database, enrollmentToken);
    assert.equal(prepared.prepared, true); assert.ok(prepared.expiresAt);
    const replay = await prepare(database, enrollmentToken);
    assert.equal(replay.expiresAt, prepared.expiresAt);
    const tokenHash = hash(enrollmentToken);
    const challenge = await rpc<Challenge>(database, "authenti8_device_enrollment_challenge", { tokenHash });
    assert.equal(challenge.valid, true); assert.ok(challenge.challenge);
    const enrolled = await complete(database, tokenHash);
    assert.equal(enrolled.enrolled, true); assert.ok(enrolled.deviceId);
    const recovered = await rpc<Enrollment>(database, "authenti8_replay_device_enrollment", {
      tokenHash, publicKeyFingerprint: hash("key"),
    });
    assert.equal(recovered.enrolled, true); assert.equal(recovered.deviceId, enrolled.deviceId);
    assert.deepEqual(await rpc(database, "authenti8_replay_device_enrollment", {
      tokenHash, publicKeyFingerprint: hash("different-key"),
    }), { enrolled: false, reason: "TOKEN_UNAVAILABLE" });
    assert.deepEqual(await complete(database, tokenHash),
      { enrolled: false, reason: "TOKEN_UNAVAILABLE" });
    const stored = await database.query<{ secret_hash: string }>("SELECT secret_hash FROM device_enrollment_secrets");
    assert.equal(stored.rows[0]?.secret_hash, tokenHash);
    assert.notEqual(stored.rows[0]?.secret_hash, enrollmentToken);
  } finally { await database.close(); }
});

test("unenrolled sessions and invalid event ordering are rejected", async () => {
  const database = await fixture();
  try {
    const sessionId = await session(database);
    assert.deepEqual(await rpc(database, "authenti8_agent_context", {
      verificationSessionId: sessionId,
    }), { authorized: false, reason: "DEVICE_NOT_ENROLLED" });
    const enrollmentToken = "f".repeat(64);
    await prepare(database, enrollmentToken);
    const tokenHash = hash(enrollmentToken);
    await rpc<Challenge>(database, "authenti8_device_enrollment_challenge", { tokenHash });
    await complete(database, tokenHash);
    const invalid = await ingest(database, sessionId, 1, "", "MONITORING_STARTED");
    assert.deepEqual(invalid, { accepted: false, reason: "INVALID_SEQUENCE" });
    const beforeStart = await monitoringState(database);
    assert.deepEqual(beforeStart, { interview: "DEVICE_CONNECTING", session: "CONSENTED",
      reservation: "RESERVED" });
    const premature = await ingest(database, sessionId, 0, "", "HEARTBEAT");
    assert.deepEqual(premature, { accepted: false, reason: "MONITORING_NOT_STARTED" });
    assert.equal((await ingest(database, sessionId, 0, "", "MONITORING_STARTED")).accepted, true);
    assert.equal((await ingest(database, sessionId, 1, hash("event-0"), "HEARTBEAT")).accepted, true);
    await database.query(`UPDATE verification_sessions SET eligible_end = now() - interval '1 second'
      WHERE id = $1`, [sessionId]);
    assert.deepEqual(await ingest(database, sessionId, 2, hash("event-1"), "HEARTBEAT"),
      { accepted: false, reason: "EVENT_OUTSIDE_WINDOW" });
    const stopId = randomUUID();
    assert.equal((await ingest(database, sessionId, 2, hash("event-1"),
      "MONITORING_STOPPED", stopId)).accepted, true);
    assert.equal((await ingest(database, sessionId, 2, hash("event-1"),
      "MONITORING_STOPPED", stopId)).replayed, true);
    const completedContext = await rpc<{ authorized: boolean; replayOnly: boolean }>(
      database, "authenti8_agent_context", { verificationSessionId: sessionId });
    assert.equal(completedContext.authorized, true);
    assert.equal(completedContext.replayOnly, true);
    assert.equal((await ingest(database, sessionId, 3, hash("event-2"), "HEARTBEAT")).accepted, false);
    assert.deepEqual(await monitoringState(database), { interview: "MEETING_COMPLETED", session: "COMPLETED",
      reservation: "CONSUMED" });
  } finally { await database.close(); }
});

async function fixture() {
  const database = new PGlite({ extensions: { pgcrypto } });
  await database.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY)");
  await database.exec(loadMigrations());
  const user = await rpc<{ id: string }>(database, "authenti8_create_user", {
    email: "owner@device.test", fullName: "Device Owner",
  });
  await database.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [user.id]);
  const created = await rpc<{ organization: { id: string } }>(database,
    "authenti8_create_organization", { userId: user.id, name: "Device Test",
      domain: "device.test", jobRole: "FOUNDER", companySize: "1-10",
      expectedMonthlyInterviews: 0, timezone: "UTC" });
  const organizationId = created.organization.id; const interviewId = randomUUID();
  await database.query(`INSERT INTO interviews(id,organization_id,google_event_id,
    google_calendar_id,google_meet_code,google_meet_url,title,candidate_email,organizer_email,
    scheduled_start,scheduled_end,status) VALUES ($1,$2,$3,'primary','abc-defg-hij',
    'https://meet.google.com/abc-defg-hij','Interview','candidate@test.dev','owner@device.test',
    now()-interval '1 minute',now()+interval '1 hour','DEVICE_CONNECTING')`,
  [interviewId, organizationId, randomUUID()]);
  await database.query(`INSERT INTO verification_sessions(interview_id,candidate_email,status,
    consent_version,consented_at,eligible_start,eligible_end) VALUES ($1,'candidate@test.dev',
    'CONSENTED','2026-01-01',now(),now()-interval '15 minutes',now()+interval '90 minutes')`, [interviewId]);
  await database.query(`INSERT INTO credit_reservations(organization_id,interview_id,status)
    VALUES ($1,$2,'RESERVED')`, [organizationId, interviewId]);
  await database.query("UPDATE interviews SET protection_status = 'RESERVED' WHERE id = $1", [interviewId]);
  return database;
}

async function prepare(database: PGlite, enrollmentToken: string) {
  return rpc<Prepared>(database, "authenti8_prepare_device_enrollment", {
    verificationSessionId: await session(database), secretHash: hash(enrollmentToken),
  });
}

async function complete(database: PGlite, tokenHash: string) {
  return rpc<Enrollment>(database, "authenti8_complete_device_enrollment", { tokenHash,
    signatureVerified: true, publicKey: "test-public-key", publicKeyFingerprint: hash("key"),
    platform: "WINDOWS", platformVersion: "11", agentVersion: "0.1.0", deviceName: "Test" });
}

async function ingest(database: PGlite, verificationSessionId: string, sequenceNumber: number,
  previousEventHash: string, eventType: string, eventId = randomUUID()) {
  return rpc<Ingested>(database, "authenti8_ingest_agent_event", { verificationSessionId,
    eventId, sequenceNumber, eventType, eventTimestamp: new Date().toISOString(),
    monotonicTimestamp: sequenceNumber, platform: "WINDOWS", payload: {}, payloadHash: hash("{}"),
    previousEventHash, agentVersion: "0.1.0", rulePackVersion: "test", signature: "signature",
    eventChainHash: hash(`event-${sequenceNumber}`) });
}

async function session(database: PGlite) {
  const result = await database.query<{ id: string }>("SELECT id FROM verification_sessions");
  return result.rows[0]!.id;
}

async function monitoringState(database: PGlite) {
  const result = await database.query<{ interview: string; session: string; reservation: string }>(`SELECT
    interview.status AS interview, session.status AS session, reservation.status AS reservation
    FROM interviews interview JOIN verification_sessions session ON session.interview_id = interview.id
    JOIN credit_reservations reservation ON reservation.interview_id = interview.id`);
  return result.rows[0];
}

async function rpc<T>(database: PGlite, name: string, input: object) {
  const result = await database.query<{ value: T }>(`SELECT ${name}($1::jsonb) AS value`, [JSON.stringify(input)]);
  return result.rows[0]!.value;
}

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function loadMigrations() { const directory = resolve(process.cwd(), "../../infrastructure/postgres");
  return readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()
    .map((file) => readFileSync(resolve(directory, file), "utf8")).join("\n"); }
type Prepared = { prepared: boolean; expiresAt: string };
type Challenge = { valid: boolean; challenge: string; verificationSessionId: string };
type Enrollment = { enrolled: boolean; deviceId?: string; reason?: string };
type Ingested = { accepted: boolean; reason?: string; replayed?: boolean };
