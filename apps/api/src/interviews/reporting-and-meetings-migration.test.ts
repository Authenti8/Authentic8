import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

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
  } finally { await database.close(); }
});

type MeetingsPage = { items: Array<{ candidateEmail: string }>; nextCursor: string | null };
type Fixture = { database: PGlite; userId: string; organizationId: string;
  otherOrganizationId: string };

async function reportingFixture(): Promise<Fixture> {
  const database = new PGlite({ extensions: { pgcrypto } });
  await database.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY)");
  await database.exec(loadMigrations());
  const owner = await rpc<{ id: string }>(database, "authenti8_create_user", {
    email: "owner@reporting.test", fullName: "Reporting Owner",
  });
  const other = await rpc<{ id: string }>(database, "authenti8_create_user", {
    email: "other@reporting.test", fullName: "Other Owner",
  });
  await database.query("UPDATE users SET email_verified_at = now() WHERE id IN ($1,$2)",
    [owner.id, other.id]);
  const first = await rpc<{ organization: { id: string } }>(database,
    "authenti8_create_organization", organizationInput(owner.id, "reporting.test"));
  const second = await rpc<{ organization: { id: string } }>(database,
    "authenti8_create_organization", organizationInput(other.id, "other-reporting.test"));
  return { database, userId: owner.id, organizationId: first.organization.id,
    otherOrganizationId: second.organization.id };
}

async function insertInterview(database: PGlite, organizationId: string, candidateName: string,
  candidateEmail: string, start: Date, status = "PROTECTED") {
  const id = randomUUID();
  await database.query(`INSERT INTO interviews(id, organization_id, google_event_id,
    google_calendar_id, google_meet_code, google_meet_url, candidate_email, candidate_name,
    organizer_email, title, scheduled_start, scheduled_end, status, protection_status)
    VALUES ($1,$2,$3,'primary',$4,$5,$6,$7,'interviewer@reporting.test','Engineering interview',
      $8,$9,$10,'RESERVED')`, [id, organizationId, `event-${id}`, id.slice(0, 11),
    `https://meet.google.com/${id.slice(0, 11)}`, candidateEmail, candidateName,
    start, new Date(start.getTime() + 30 * 60_000), status]);
  return id;
}

function organizationInput(userId: string, domain: string) {
  return { userId, name: domain.split(".")[0], domain, jobRole: "Founder", timezone: "UTC",
    companySize: "1-10", expectedMonthlyInterviews: 10 };
}

function loadMigrations(include: (file: string) => boolean = () => true) {
  const directory = resolve(process.cwd(), "../../infrastructure/postgres");
  return readdirSync(directory).filter((file) => /^\d+.*\.sql$/.test(file) && include(file)).sort()
    .map((file) => readFileSync(resolve(directory, file), "utf8")).join("\n");
}

async function rpc<T>(database: PGlite, name: string, input: Record<string, unknown> = {}) {
  const result = await database.query<{ result: T }>(`SELECT ${name}($1::jsonb) AS result`,
    [JSON.stringify(input)]);
  return result.rows[0]!.result;
}
