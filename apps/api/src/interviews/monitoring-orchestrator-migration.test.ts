import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test("missed and restored heartbeats produce one measured interruption", async () => {
  const fixture = await monitoringFixture(60_000);
  try {
    const heartbeatAt = new Date(fixture.clock.getTime() - 20_000);
    await fixture.database.query(`INSERT INTO agent_heartbeats(
      verification_session_id, sequence_number, received_at) VALUES ($1,1,$2)`,
    [fixture.sessionId, heartbeatAt]);
    const first = await rpc<Orchestration>(fixture.database, "authenti8_orchestrate_monitoring",
      { at: fixture.clock.toISOString() });
    assert.deepEqual(first, { interruptionsOpened: 1, sessionsStopped: 0 });
    const replay = await rpc<Orchestration>(fixture.database, "authenti8_orchestrate_monitoring",
      { at: fixture.clock.toISOString() });
    assert.deepEqual(replay, { interruptionsOpened: 0, sessionsStopped: 0 });
    const resumedAt = new Date(fixture.clock.getTime() + 5_000);
    await fixture.database.query(`INSERT INTO agent_heartbeats(
      verification_session_id, sequence_number, received_at) VALUES ($1,2,$2)`,
    [fixture.sessionId, resumedAt]);
    const interruption = await fixture.database.query<{ ended_at: string }>(
      "SELECT ended_at FROM monitoring_interruptions WHERE verification_session_id = $1",
      [fixture.sessionId]);
    assert.equal(new Date(interruption.rows[0]!.ended_at).getTime(), resumedAt.getTime());
    const stopped = await rpc<{ stopped: boolean; coveragePercentage: number }>(fixture.database,
      "authenti8_finish_monitoring", { verificationSessionId: fixture.sessionId,
        endedAt: new Date(fixture.clock.getTime() + 20_000).toISOString(), reason: "RECRUITER_ENDED" });
    assert.equal(stopped.stopped, true);
    assert.equal(Number(stopped.coveragePercentage), 75);
  } finally { await fixture.database.close(); }
});

test("the authorized end stops monitoring even while interrupted", async () => {
  const fixture = await monitoringFixture(-1_000);
  try {
    const result = await rpc<Orchestration>(fixture.database, "authenti8_orchestrate_monitoring",
      { at: fixture.clock.toISOString() });
    assert.deepEqual(result, { interruptionsOpened: 1, sessionsStopped: 1 });
    const state = await fixture.database.query<{ status: string; health: string;
      reason: string; coverage: number }>(`SELECT status, monitoring_health AS health,
      stop_reason AS reason, coverage_percentage AS coverage FROM verification_sessions
      WHERE id = $1`, [fixture.sessionId]);
    assert.equal(state.rows[0]?.status, "COMPLETED");
    assert.equal(state.rows[0]?.health, "COMPLETED");
    assert.equal(state.rows[0]?.reason, "AUTHORIZED_WINDOW_ENDED");
    assert.ok(Number(state.rows[0]?.coverage) >= 0);
  } finally { await fixture.database.close(); }
});

test("an ingest-completed session is still finalized with coverage", async () => {
  const fixture = await monitoringFixture(60_000);
  try {
    await fixture.database.query(`UPDATE verification_sessions SET status = 'COMPLETED',
      monitoring_ended_at = now() WHERE id = $1`, [fixture.sessionId]);
    const result = await rpc<{ stopped: boolean; coveragePercentage: number }>(fixture.database,
      "authenti8_finish_monitoring", { verificationSessionId: fixture.sessionId,
        endedAt: fixture.clock.toISOString(), reason: "AGENT_MONITORING_STOPPED" });
    assert.equal(result.stopped, true);
    assert.equal(Number(result.coveragePercentage), 100);
    const state = await fixture.database.query<{ health: string; reason: string }>(
      `SELECT monitoring_health AS health, stop_reason AS reason
       FROM verification_sessions WHERE id = $1`, [fixture.sessionId]);
    assert.deepEqual(state.rows[0], { health: "COMPLETED", reason: "AGENT_MONITORING_STOPPED" });
  } finally { await fixture.database.close(); }
});

test("delivery grace never extends monitoring coverage past the eligible end", async () => {
  const fixture = await monitoringFixture(10_000);
  try {
    const requestedEnd = new Date(fixture.clock.getTime() + 4 * 60_000);
    await rpc(fixture.database, "authenti8_finish_monitoring", {
      verificationSessionId: fixture.sessionId, endedAt: requestedEnd.toISOString(),
      reason: "AGENT_MONITORING_STOPPED",
    });
    const state = await fixture.database.query<{ ended: string; eligible: string; coverage: number }>(
      `SELECT monitoring_ended_at AS ended, eligible_end AS eligible,
       coverage_percentage AS coverage FROM verification_sessions WHERE id = $1`,
      [fixture.sessionId]);
    assert.equal(new Date(state.rows[0]!.ended).getTime(), new Date(state.rows[0]!.eligible).getTime());
    assert.equal(Number(state.rows[0]!.coverage), 100);
  } finally { await fixture.database.close(); }
});

test("late orchestration does not open an interruption after the eligible end", async () => {
  const fixture = await monitoringFixture(-20_000);
  try {
    const eligibleEnd = new Date(fixture.clock.getTime() - 20_000);
    await fixture.database.query(`INSERT INTO agent_heartbeats(
      verification_session_id, sequence_number, received_at) VALUES ($1,1,$2)`,
    [fixture.sessionId, new Date(eligibleEnd.getTime() - 2_000)]);
    const result = await rpc<Orchestration>(fixture.database, "authenti8_orchestrate_monitoring",
      { at: fixture.clock.toISOString() });
    assert.deepEqual(result, { interruptionsOpened: 0, sessionsStopped: 1 });
    const interruptions = await fixture.database.query(
      "SELECT id FROM monitoring_interruptions WHERE verification_session_id = $1",
      [fixture.sessionId]);
    assert.equal(interruptions.rows.length, 0);
  } finally { await fixture.database.close(); }
});

async function monitoringFixture(endOffset: number) {
  const database = new PGlite({ extensions: { pgcrypto } });
  await database.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY)");
  await database.exec(loadMigrations());
  const user = await rpc<{ id: string }>(database, "authenti8_create_user", {
    email: `${randomUUID()}@monitoring.test`, fullName: "Monitoring Owner",
  });
  await database.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [user.id]);
  const created = await rpc<{ organization: { id: string } }>(database,
    "authenti8_create_organization", { userId: user.id, name: "Monitoring Test",
      domain: `${randomUUID()}.test`, jobRole: "FOUNDER", companySize: "1-10",
      expectedMonthlyInterviews: 0, timezone: "UTC" });
  const clock = new Date(); const interviewId = randomUUID(); const sessionId = randomUUID();
  await database.query(`INSERT INTO interviews(id, organization_id, google_event_id,
    google_calendar_id, google_meet_code, google_meet_url, title, candidate_email,
    organizer_email, scheduled_start, scheduled_end, status, monitoring_started_at)
    VALUES ($1,$2,$3,'primary','abc-defg-hij','https://meet.google.com/abc-defg-hij',
    'Interview','candidate@test.dev','owner@monitoring.test',$4,$5,'MONITORING_ACTIVE',$4)`,
  [interviewId, created.organization.id, randomUUID(),
    new Date(clock.getTime() - 60_000), new Date(clock.getTime() + endOffset)]);
  await database.query(`INSERT INTO verification_sessions(id, interview_id, candidate_email,
    status, eligible_start, eligible_end, monitoring_started_at, monitoring_health)
    VALUES ($1,$2,'candidate@test.dev','MONITORING_ACTIVE',$3,$4,$3,'ACTIVE')`,
  [sessionId, interviewId, new Date(clock.getTime() - 60_000),
    new Date(clock.getTime() + endOffset)]);
  return { database, clock, interviewId, sessionId };
}

async function rpc<T>(database: PGlite, name: string, input: object) {
  const result = await database.query<{ value: T }>(`SELECT ${name}($1::jsonb) AS value`,
    [JSON.stringify(input)]);
  return result.rows[0]!.value;
}

function loadMigrations() {
  const directory = resolve(process.cwd(), "../../infrastructure/postgres");
  return readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()
    .map((file) => readFileSync(resolve(directory, file), "utf8")).join("\n");
}

type Orchestration = { interruptionsOpened: number; sessionsStopped: number };
