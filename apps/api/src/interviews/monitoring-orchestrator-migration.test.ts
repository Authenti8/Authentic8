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
test("recruiter live logs are workspace-bound, cursor-resumable, and backend-authored", async () => {
  const fixture = await monitoringFixture(60_000);
  try {
    await insertLatestDevice(fixture);
    const meeting = await rpc<{ protected: boolean; interviewId: string; platform: string }>(
      fixture.database,
      "authenti8_recruiter_meeting", { userId: fixture.userId,
        organizationId: fixture.organizationId, meetCode: "abc-defg-hij" });
    assert.equal(meeting.protected, true);
    assert.equal(meeting.interviewId, fixture.interviewId);
    assert.equal(meeting.platform, "MACOS");
    const first = await rpc<{ authorized: boolean; events: { sequence: number }[] }>(fixture.database,
      "authenti8_recruiter_logs", { userId: fixture.userId, interviewId: fixture.interviewId,
        organizationId: fixture.organizationId, after: 0 });
    assert.equal(first.authorized, true);
    assert.ok(first.events.length > 0);
    await fixture.database.query(`INSERT INTO telemetry_events(id, verification_session_id,
      sequence_number, event_type, event_timestamp, monotonic_timestamp, platform, payload,
      payload_hash, agent_version, rule_pack_version, signature)
      VALUES ($1,$2,0,'MONITORING_STARTED',now(),0,'WINDOWS','{}',$3,'1.0.0','pack','signature')`,
    [randomUUID(), fixture.sessionId, "a".repeat(64)]);
    const activeLogs = await fixture.database.query<{ count: number }>(`SELECT count(*)::INTEGER
      AS count FROM recruiter_live_events WHERE interview_id = $1 AND kind = 'MONITORING_ACTIVE'`,
    [fixture.interviewId]);
    assert.equal(activeLogs.rows[0]!.count, 1);
    const cursor = first.events.at(-1)!.sequence;
    const replay = await rpc<{ events: unknown[] }>(fixture.database, "authenti8_recruiter_logs",
      { userId: fixture.userId, organizationId: fixture.organizationId,
        interviewId: fixture.interviewId, after: cursor });
    assert.deepEqual(replay.events, []);
    const denied = await rpc<{ authorized: boolean }>(fixture.database, "authenti8_recruiter_logs",
      { userId: fixture.userId, organizationId: randomUUID(),
        interviewId: fixture.interviewId, after: 0 });
    assert.equal(denied.authorized, false);
    await assertRecruiterTokenRotation(fixture);
    await assertLiveEventSources(fixture);
  } finally { await fixture.database.close(); }
});
test("reused Meet codes do not expose interviews outside their authorized window", async () => {
  const fixture = await monitoringFixture(60_000);
  try {
    await fixture.database.query(`UPDATE interviews SET scheduled_start = now() - interval '2 days',
      scheduled_end = now() - interval '1 day' WHERE id = $1`, [fixture.interviewId]);
    const meeting = await rpc<{ protected: boolean }>(fixture.database,
      "authenti8_recruiter_meeting", { userId: fixture.userId,
        organizationId: fixture.organizationId, meetCode: "abc-defg-hij" });
    assert.equal(meeting.protected, false);
    const logs = await rpc<{ authorized: boolean }>(fixture.database, "authenti8_recruiter_logs",
      { userId: fixture.userId, organizationId: fixture.organizationId,
        interviewId: fixture.interviewId, after: 0 });
    assert.equal(logs.authorized, false);
  } finally { await fixture.database.close(); }
});
test("published rule packs preserve the exact signed agent payload", async () => {
  const fixture = await monitoringFixture(60_000);
  try {
    const creator = await rpc<{ id: string }>(fixture.database, "authenti8_create_user", {
      email: `${randomUUID()}@rules.test`, fullName: "Rule Creator",
    });
    const conditions = { executableSha256: ["a".repeat(64)], signerThumbprints: [],
      productNames: [] };
    const inserted = await fixture.database.query<{ id: string }>(`INSERT INTO detection_rules(
      rule_key, product_family, platform, signal_type, match_condition, confidence,
      required_supporting_signals, version, created_by) VALUES
      ('tool.identity','Supported Tool','WINDOWS','PROCESS',$2,'HIGH','[]',3,$1)
      RETURNING id`, [creator.id, JSON.stringify(conditions)]);
    const ruleId = inserted.rows[0]!.id;
    const tenantRejected = await rpc<{ approved: boolean }>(fixture.database,
      "authenti8_approve_detection_rule", { userId: fixture.userId, ruleId });
    assert.equal(tenantRejected.approved, false);
    await fixture.database.query(`INSERT INTO detection_rule_operators(user_id) VALUES ($1)`,
      [fixture.userId]);
    await assertMalformedSupportingSignals(fixture, creator.id);
    const approved = await rpc<{ approved: boolean }>(fixture.database,
      "authenti8_approve_detection_rule", { userId: fixture.userId, ruleId });
    assert.equal(approved.approved, true);
    const payload = { version: "windows-3", expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      rules: [{ key: "tool.identity", family: "Supported Tool", version: 3, enabled: true,
        ...conditions }] };
    const substituted = structuredClone(payload);
    substituted.rules[0]!.executableSha256 = ["b".repeat(64)];
    const rejected = await rpc<{ published: boolean }>(fixture.database,
      "authenti8_publish_rule_pack", { userId: fixture.userId, platform: "WINDOWS",
        ruleIds: [ruleId], payload: substituted, signature: "signed-substituted-payload" });
    assert.equal(rejected.published, false);
    const published = await rpc<{ published: boolean }>(fixture.database,
      "authenti8_publish_rule_pack", { userId: fixture.userId, platform: "WINDOWS",
        ruleIds: [ruleId], payload, signature: "signed-canonical-payload" });
    assert.equal(published.published, true);
    const active = await rpc<Record<string, unknown>>(fixture.database,
      "authenti8_active_rule_pack", { platform: "WINDOWS" });
    assert.deepEqual(active, { ...payload, available: true, signature: "signed-canonical-payload" });
    assert.equal(JSON.stringify(active).includes("rule_key"), false);
    const disabled = await rpc<{ disabled: boolean }>(fixture.database,
      "authenti8_disable_detection_rule", { userId: fixture.userId, ruleId });
    assert.equal(disabled.disabled, true);
    const unavailable = await rpc<{ available: boolean; fallbackAllowed: boolean }>(fixture.database,
      "authenti8_active_rule_pack", { platform: "WINDOWS" });
    assert.deepEqual(unavailable, { available: false, fallbackAllowed: false });
  } finally { await fixture.database.close(); }
});
test("rule-pack publication rejects malformed expiry timestamps", async () => {
  const fixture = await monitoringFixture(60_000);
  try {
    await fixture.database.query(`INSERT INTO detection_rule_operators(user_id) VALUES ($1)`,
      [fixture.userId]);
    const result = await rpc<{ published: boolean; reason: string }>(fixture.database,
      "authenti8_publish_rule_pack", { userId: fixture.userId, platform: "WINDOWS",
        ruleIds: [randomUUID()], payload: { version: "invalid", expiresAt: "not-a-date", rules: [] },
        signature: "signature" });
    assert.deepEqual(result, { published: false, reason: "INVALID_PACK" });
  } finally { await fixture.database.close(); }
});

test("medium decisions reject non-technical corroboration", async () => {
  const fixture = await monitoringFixture(60_000);
  try {
    await fixture.database.query(`INSERT INTO detection_rules(rule_key, product_family, platform,
      signal_type, match_condition, confidence, required_supporting_signals, version, enabled, status)
      VALUES ('tool.support','Tool','WINDOWS','PROCESS','{}','MEDIUM','[]',1,true,'PUBLISHED'),
      ('tool.primary','Tool','WINDOWS','OVERLAY','{}','MEDIUM','["tool.support"]',1,true,'PUBLISHED'),
      ('tool.empty','Tool','WINDOWS','OVERLAY','{}','MEDIUM','["tool.support"]',1,true,'PUBLISHED'),
      ('tool.self','Tool','WINDOWS','OVERLAY','{}','MEDIUM','["tool.self"]',1,true,'PUBLISHED'),
      ('tool.excluded','Tool','WINDOWS','OVERLAY','{}','HIGH','[]',1,true,'PUBLISHED')`);
    const packRules = [{ key: "tool.support", version: 1 }, { key: "tool.primary", version: 1 },
      { key: "tool.empty", version: 1 }, { key: "tool.self", version: 1 }];
    await fixture.database.query(`INSERT INTO detection_rule_packs(platform, version, rules,
      signed_payload, signature, expires_at, published_by) VALUES
      ('WINDOWS','pack-v1',$1,$2,'signature',now() + interval '1 day',$3)`,
    [JSON.stringify(packRules), JSON.stringify({ version: "pack-v1",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), rules: packRules }), fixture.userId]);
    await insertSignal(fixture, 0, "tool.primary", ["PRODUCT_METADATA"]);
    assert.equal(await incidentCount(fixture), 0);
    await insertSignal(fixture, 1, "tool.support", ["PRODUCT_METADATA"]);
    assert.equal(await incidentCount(fixture), 1);
    await insertSignal(fixture, 2, "tool.empty", []);
    await insertSignal(fixture, 3, "tool.self", ["PRODUCT_METADATA"]);
    assert.equal(await incidentCount(fixture), 1);
    await insertMalformedSignal(fixture, 4);
    await insertSignal(fixture, 5, "tool.excluded", ["EXECUTABLE_SHA256"], "HIDDEN_OVERLAY_MATCH");
    assert.equal(await incidentCount(fixture), 1);
  } finally { await fixture.database.close(); }
});

test("only an enabled browser extension confirms within its pack's historical window", async () => {
  const fixture = await monitoringFixture(60_000);
  try {
    await fixture.database.query(`INSERT INTO detection_rules(rule_key, product_family, platform,
      signal_type, match_condition, confidence, required_supporting_signals, version, enabled, status)
      VALUES ('browser.tool','Browser Tool','CHROME','EXTENSION','{}','HIGH','[]',7,true,'PUBLISHED')`);
    const extensionId = "a".repeat(32);
    const rules = [{ key: "browser.tool", version: 7, extensionIds: [extensionId] }];
    await fixture.database.query(`INSERT INTO detection_rule_packs(platform, version, rules,
      signed_payload, signature, expires_at, published_by, published_at, disabled_at) VALUES
      ('CHROME','chrome-7',$1,$2,'signature',now() + interval '1 day',$3,
      now() - interval '2 hours',now() - interval '1 hour')`,
    [JSON.stringify(rules), JSON.stringify({ version: "chrome-7",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), rules }), fixture.userId]);
    await fixture.database.query(`INSERT INTO telemetry_events(id, verification_session_id,
      sequence_number, event_type, event_timestamp, monotonic_timestamp, platform, payload,
      payload_hash, agent_version, rule_pack_version, signature)
      VALUES ($1,$2,0,'BROWSER_EXTENSION_MATCH',now() - interval '90 minutes',0,'WINDOWS',$3,$4,'1.0.0',
      'windows-12','signature')`, [randomUUID(), fixture.sessionId, JSON.stringify({
        extensionId, ruleKey: "browser.tool", ruleVersion: 7,
        rulePackVersion: "chrome-7", enabled: false }), "a".repeat(64)]);
    assert.equal(await incidentCount(fixture), 0);
    await fixture.database.query(`INSERT INTO telemetry_events(id, verification_session_id,
      sequence_number, event_type, event_timestamp, monotonic_timestamp, platform, payload,
      payload_hash, agent_version, rule_pack_version, signature)
      VALUES ($1,$2,1,'BROWSER_EXTENSION_CHANGED',now() - interval '90 minutes',1,'WINDOWS',$3,$4,'1.0.0',
      'windows-12','signature')`, [randomUUID(), fixture.sessionId, JSON.stringify({
        extensionId, ruleKey: "browser.tool", ruleVersion: 7,
        rulePackVersion: "chrome-7", enabled: true }), "a".repeat(64)]);
    assert.equal(await incidentCount(fixture), 1);
  } finally { await fixture.database.close(); }
});

test("Chrome evidence can corroborate a native medium-confidence rule", async () => {
  const fixture = await monitoringFixture(60_000);
  try {
    await fixture.database.query(`INSERT INTO detection_rules(rule_key, product_family, platform,
      signal_type, match_condition, confidence, required_supporting_signals, version, enabled, status)
      VALUES ('browser.support','Tool','CHROME','EXTENSION','{}','MEDIUM','[]',1,true,'PUBLISHED'),
      ('native.primary','Tool','WINDOWS','PROCESS','{}','MEDIUM','["browser.support"]',1,true,'PUBLISHED')`);
    const chromeRules = [{ key: "browser.support", version: 1, extensionIds: ["a".repeat(32)] }];
    const nativeRules = [{ key: "native.primary", version: 1 }];
    await fixture.database.query(`INSERT INTO detection_rule_packs(platform, version, rules,
      signed_payload, signature, expires_at, published_by) VALUES
      ('CHROME','chrome-v1',$1,$2,'signature',now() + interval '1 day',$5),
      ('WINDOWS','pack-v1',$3,$4,'signature',now() + interval '1 day',$5)`,
    [JSON.stringify(chromeRules), JSON.stringify({ version: "chrome-v1", rules: chromeRules }),
      JSON.stringify(nativeRules), JSON.stringify({ version: "pack-v1", rules: nativeRules }),
      fixture.userId]);
    await fixture.database.query(`INSERT INTO telemetry_events(id, verification_session_id,
      sequence_number, event_type, event_timestamp, monotonic_timestamp, platform, payload,
      payload_hash, agent_version, rule_pack_version, signature)
      VALUES ($1,$2,0,'BROWSER_EXTENSION_MATCH',now(),0,'WINDOWS',$3,$4,'1.0.0',
      'pack-v1','signature')`, [randomUUID(), fixture.sessionId, JSON.stringify({
        extensionId: "b".repeat(32), ruleKey: "browser.support", ruleVersion: 1,
        rulePackVersion: "chrome-v1", enabled: true }), "a".repeat(64)]);
    await fixture.database.query(`UPDATE detection_rule_packs SET
      published_at = now() - interval '2 days', expires_at = now() - interval '1 day'
      WHERE platform = 'CHROME'`);
    await insertSignal(fixture, 1, "native.primary", ["PRODUCT_METADATA"]);
    assert.equal(await incidentCount(fixture), 0);
    await fixture.database.query(`UPDATE detection_rule_packs SET
      published_at = now(), expires_at = now() + interval '1 day' WHERE platform = 'CHROME'`);
    await insertSignal(fixture, 2, "native.primary", ["PRODUCT_METADATA"]);
    assert.equal(await incidentCount(fixture), 0);
    await fixture.database.query(`INSERT INTO telemetry_events(id, verification_session_id,
      sequence_number, event_type, event_timestamp, monotonic_timestamp, platform, payload,
      payload_hash, agent_version, rule_pack_version, signature)
      VALUES ($1,$2,3,'BROWSER_EXTENSION_MATCH',now(),3,'WINDOWS',$3,$4,'1.0.0',
      'pack-v1','signature')`, [randomUUID(), fixture.sessionId, JSON.stringify({
        extensionId: "a".repeat(32), ruleKey: "browser.support", ruleVersion: 1,
        rulePackVersion: "chrome-v1", enabled: true }), "a".repeat(64)]);
    await insertSignal(fixture, 4, "native.primary", ["PRODUCT_METADATA"]);
    assert.ok(await incidentCount(fixture) >= 1);
  } finally { await fixture.database.close(); }
});

test("high-confidence process identity with active use creates an incident", async () => {
  const fixture = await monitoringFixture(60_000);
  try {
    const rules = [{ key: "tool.process", version: 1 }];
    await fixture.database.query(`INSERT INTO detection_rules(rule_key, product_family, platform,
      signal_type, match_condition, confidence, required_supporting_signals, version, enabled, status)
      VALUES ('tool.process','Tool','WINDOWS','PROCESS','{}','HIGH','[]',1,true,'PUBLISHED')`);
    await fixture.database.query(`INSERT INTO detection_rule_packs(platform, version, rules,
      signed_payload, signature,
      expires_at, published_by) VALUES ('WINDOWS','process-v1',$1,$2,'signature',
      now() + interval '1 day',$3)`, [JSON.stringify(rules), JSON.stringify({ version: "process-v1",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(), rules }), fixture.userId]);
    await fixture.database.query(`INSERT INTO telemetry_events(id, verification_session_id,
      sequence_number, event_type, event_timestamp, monotonic_timestamp, platform, payload,
      payload_hash, agent_version, rule_pack_version, signature)
      VALUES ($1,$2,0,'KNOWN_PROCESS_MATCH',now(),0,'WINDOWS',$3,$4,'1.0.0',
      'process-v1','signature')`, [randomUUID(), fixture.sessionId, JSON.stringify({
        ruleKey: "tool.process", ruleVersion: 1, identityEvidence: ["SIGNER_THUMBPRINT"],
        activeUseEvidence: ["AUDIO_ROUTE"] }), "a".repeat(64)]);
    assert.equal(await incidentCount(fixture), 1);
  } finally { await fixture.database.close(); }
});

test("unverified browser rule packs reduce coverage until browser health recovers", async () => {
  const fixture = await monitoringFixture(60_000);
  try {
    const unhealthyAt = new Date();
    await fixture.database.query(`INSERT INTO agent_heartbeats(verification_session_id,
      sequence_number, received_at) VALUES ($1,1,$2)`, [fixture.sessionId, unhealthyAt]);
    await insertBrowserHealth(fixture, 0, unhealthyAt, false, "RULE_PACK_UNAVAILABLE");
    await fixture.database.query(`INSERT INTO agent_heartbeats(verification_session_id,
      sequence_number, received_at) VALUES ($1,2,$2)`,
    [fixture.sessionId, new Date(unhealthyAt.getTime() + 1_000)]);
    const open = await fixture.database.query<{ reason: string }>(`SELECT reason
      FROM monitoring_interruptions WHERE verification_session_id = $1 AND ended_at IS NULL`,
    [fixture.sessionId]);
    assert.equal(open.rows[0]?.reason, "RULE_PACK_UNAVAILABLE");
    await insertBrowserHealth(fixture, 1, new Date(unhealthyAt.getTime() + 2_000), true);
    const health = await fixture.database.query<{ health: string; open: number }>(`SELECT
      monitoring_health AS health, (SELECT count(*)::INTEGER FROM monitoring_interruptions
      WHERE verification_session_id = $1 AND ended_at IS NULL) AS open
      FROM verification_sessions WHERE id = $1`, [fixture.sessionId]);
    assert.deepEqual(health.rows[0], { health: "ACTIVE", open: 0 });
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
  return { database, clock, interviewId, sessionId, userId: user.id,
    organizationId: created.organization.id };
}

async function rpc<T>(database: PGlite, name: string, input: object) {
  const result = await database.query<{ value: T }>(`SELECT ${name}($1::jsonb) AS value`,
    [JSON.stringify(input)]);
  return result.rows[0]!.value;
}

async function insertSignal(fixture: Awaited<ReturnType<typeof monitoringFixture>>,
  sequence: number, ruleKey: string, identityEvidence: string[],
  eventType = "KNOWN_PROCESS_MATCH") {
  await fixture.database.query(`INSERT INTO telemetry_events(id, verification_session_id,
    sequence_number, event_type, event_timestamp, monotonic_timestamp, platform, payload,
    payload_hash, agent_version, rule_pack_version, signature)
    VALUES ($1,$2,$3,$6,now(),$3,'WINDOWS',$4,$5,'1.0.0','pack-v1','signature')`,
  [randomUUID(), fixture.sessionId, sequence,
    JSON.stringify({ ruleKey, ruleVersion: 1, identityEvidence }), "a".repeat(64), eventType]);
}

async function insertMalformedSignal(fixture: Awaited<ReturnType<typeof monitoringFixture>>,
  sequence: number) {
  await fixture.database.query(`INSERT INTO telemetry_events(id, verification_session_id,
    sequence_number, event_type, event_timestamp, monotonic_timestamp, platform, payload,
    payload_hash, agent_version, rule_pack_version, signature) VALUES
    ($1,$2,$3,'KNOWN_PROCESS_MATCH',now(),$3,'WINDOWS',$4,$5,'1.0.0','pack-v1','signature')`,
  [randomUUID(), fixture.sessionId, sequence,
    JSON.stringify({ ruleKey: "tool.primary", ruleVersion: "invalid" }), "a".repeat(64)]);
}

async function insertLatestDevice(fixture: Awaited<ReturnType<typeof monitoringFixture>>) {
  const session = randomUUID();
  await fixture.database.query(`INSERT INTO verification_sessions(id, interview_id,
    candidate_email, status, eligible_start, eligible_end, monitoring_health, created_at)
    VALUES ($1,$2,'candidate@test.dev','CREATED',now(),now() + interval '1 hour','PENDING',
    now() + interval '1 second')`, [session, fixture.interviewId]);
  await fixture.database.query(`INSERT INTO candidate_devices(verification_session_id,
    public_key, platform, platform_version, agent_version) VALUES ($1,'key','MACOS','15','1')`,
  [session]);
}

async function assertLiveEventSources(fixture: Awaited<ReturnType<typeof monitoringFixture>>) {
  const sources = await fixture.database.query<{ missing: number }>(`SELECT count(*)::INTEGER
    AS missing FROM recruiter_live_events WHERE source_kind IS NULL OR source_reference IS NULL`);
  assert.equal(sources.rows[0]!.missing, 0);
}

async function assertMalformedSupportingSignals(
  fixture: Awaited<ReturnType<typeof monitoringFixture>>, creatorId: string) {
  const rule = await fixture.database.query<{ id: string }>(`INSERT INTO detection_rules(
    rule_key,product_family,platform,signal_type,match_condition,confidence,
    required_supporting_signals,version,created_by) VALUES
    ('invalid.support','Tool','WINDOWS','PROCESS','{}','MEDIUM','[{}]',1,$1) RETURNING id`, [creatorId]);
  const result = await rpc<{ approved: boolean }>(fixture.database, "authenti8_approve_detection_rule",
    { userId: fixture.userId, ruleId: rule.rows[0]!.id });
  assert.equal(result.approved, false);
}

async function assertRecruiterTokenRotation(
  fixture: Awaited<ReturnType<typeof monitoringFixture>>,
) {
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const authorizationExpiresAt = new Date(Date.now() + 8 * 60 * 60_000).toISOString();
  for (const tokenHash of ["a".repeat(64), "b".repeat(64)]) {
    const issued = await rpc<{ issued: boolean }>(fixture.database,
      "authenti8_issue_recruiter_token", { userId: fixture.userId,
        organizationId: fixture.organizationId, tokenHash, expiresAt, authorizationExpiresAt });
    assert.equal(issued.issued, true);
  }
  await fixture.database.query(`UPDATE recruiter_extension_tokens SET
    created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
    WHERE token_hash = $1`, ["a".repeat(64)]);
  const rotated = await rpc<{ rotated: boolean }>(fixture.database,
    "authenti8_rotate_recruiter_token", { tokenHash: "a".repeat(64),
      replacementHash: "c".repeat(64), expiresAt });
  assert.equal(rotated.rotated, true);
  const resolve = (prefix: string) => rpc<{ valid: boolean }>(fixture.database,
    "authenti8_resolve_recruiter_token", { tokenHash: prefix.repeat(64) });
  const [revoked, retained] = await Promise.all([resolve("a"), resolve("b")]);
  assert.equal(revoked.valid, false);
  assert.equal(retained.valid, true);
}

async function incidentCount(fixture: Awaited<ReturnType<typeof monitoringFixture>>) {
  const result = await fixture.database.query<{ count: number }>(
    "SELECT count(*)::INTEGER AS count FROM detection_incidents WHERE verification_session_id = $1",
    [fixture.sessionId]);
  return result.rows[0]!.count;
}

async function insertBrowserHealth(fixture: Awaited<ReturnType<typeof monitoringFixture>>,
  sequence: number, at: Date, activeProfileVerified: boolean, reason?: string) {
  await fixture.database.query(`INSERT INTO telemetry_events(id, verification_session_id,
    sequence_number, event_type, event_timestamp, monotonic_timestamp, platform, payload,
    payload_hash, agent_version, rule_pack_version, signature)
    VALUES ($1,$2,$3,'BROWSER_PROFILE_HEALTH',$4,$3,'WINDOWS',$5,$6,'1.0.0','pack','signature')`,
  [randomUUID(), fixture.sessionId, sequence, at,
    JSON.stringify({ activeProfileVerified, ...(reason ? { reason } : {}) }), "a".repeat(64)]);
}

function loadMigrations() {
  const directory = resolve(process.cwd(), "../../infrastructure/postgres");
  return readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()
    .map((file) => readFileSync(resolve(directory, file), "utf8")).join("\n");
}

type Orchestration = { interruptionsOpened: number; sessionsStopped: number };
