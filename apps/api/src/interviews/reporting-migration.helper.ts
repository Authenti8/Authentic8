import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

export type ReportingFixture = { database: PGlite; userId: string; organizationId: string;
  otherOrganizationId: string };

export async function reportingFixture(): Promise<ReportingFixture> {
  const database = new PGlite({ extensions: { pgcrypto } });
  await database.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY)");
  await database.exec(loadMigrations());
  const owner = await rpc<{ id: string }>(database, "authenti8_create_user", {
    email: "owner@reporting.test", fullName: "Reporting Owner" });
  const other = await rpc<{ id: string }>(database, "authenti8_create_user", {
    email: "other@reporting.test", fullName: "Other Owner" });
  await database.query("UPDATE users SET email_verified_at = now() WHERE id IN ($1,$2)",
    [owner.id, other.id]);
  const first = await rpc<{ organization: { id: string } }>(database,
    "authenti8_create_organization", organizationInput(owner.id, "reporting.test"));
  const second = await rpc<{ organization: { id: string } }>(database,
    "authenti8_create_organization", organizationInput(other.id, "other-reporting.test"));
  return { database, userId: owner.id, organizationId: first.organization.id,
    otherOrganizationId: second.organization.id };
}

export async function insertInterview(database: PGlite, organizationId: string,
  candidateName: string, candidateEmail: string, start: Date, status = "PROTECTED",
  id = randomUUID()) {
  await database.query(`INSERT INTO interviews(id, organization_id, google_event_id,
    google_calendar_id, google_meet_code, google_meet_url, candidate_email, candidate_name,
    organizer_email, title, scheduled_start, scheduled_end, status, protection_status)
    VALUES ($1,$2,$3,'primary',$4,$5,$6,$7,'interviewer@reporting.test','Engineering interview',
      $8,$9,$10,'RESERVED')`, [id, organizationId, `event-${id}`, id.slice(0, 11),
    `https://meet.google.com/${id.slice(0, 11)}`, candidateEmail, candidateName,
    start, new Date(start.getTime() + 30 * 60_000), status]);
  return id;
}

export async function seedCandidateIdentity(database: PGlite, interviewId: string) {
  const sessionId = randomUUID(); const tokenId = randomUUID();
  await database.query(`INSERT INTO verification_sessions(id, interview_id, candidate_email,
    status, eligible_start, eligible_end) VALUES ($1,$2,'expired@candidate.test','COMPLETED',
    now()-interval '1 hour',now()+interval '1 hour')`, [sessionId, interviewId]);
  await database.query(`INSERT INTO candidate_devices(verification_session_id, public_key,
    platform, platform_version, agent_version) VALUES ($1,'candidate-key','WINDOWS','11','1.0.0')`,
  [sessionId]);
  await database.query(`INSERT INTO candidate_verification_tokens(id, interview_id,
    candidate_email, token_hash, expires_at, consumed_at, decision) VALUES
    ($1,$2,'expired@candidate.test',$3,now()+interval '1 hour',now(),'ACCEPTED')`,
  [tokenId, interviewId, `token-${tokenId}`]);
  await database.query(`INSERT INTO candidate_consents(interview_id, verification_token_id,
    verification_session_id, candidate_email, consent_version, decision, decided_at, accepted_at,
    ip_address, user_agent) VALUES ($1,$2,$3,'expired@candidate.test','v1','ACCEPTED',now(),now(),
    '127.0.0.1','browser')`, [interviewId, tokenId, sessionId]);
  await database.query(`INSERT INTO interview_participants(interview_id, email, participant_type,
    is_external) VALUES ($1,'expired@candidate.test','CANDIDATE',true)`, [interviewId]);
  return sessionId;
}

export async function exerciseDisputeReview(fixture: ReportingFixture, userId: string) {
  const interviewId = await insertInterview(fixture.database, fixture.organizationId,
    "Disputed Candidate", "dispute@candidate.test", new Date(), "MEETING_COMPLETED");
  const dispute = await fixture.database.query<{ id: string }>(`INSERT INTO
    candidate_disputes(interview_id,reason) VALUES ($1,'Incorrect detection') RETURNING id`,
  [interviewId]);
  const disputeId = dispute.rows[0]!.id;
  const reviewed = await rpc<{ updated: boolean }>(fixture.database,
    "authenti8_resolve_candidate_dispute", { userId, disputeId, status: "REVIEWED",
      resolution: "" });
  const overview = await rpc<{ organizations: Array<{ id: string; openDisputes: number }>;
    disputes: Array<{ id: string; status: string }> }>(fixture.database,
  "authenti8_admin_overview", { userId });
  const resolved = await rpc<{ updated: boolean }>(fixture.database,
    "authenti8_resolve_candidate_dispute", { userId, disputeId, status: "RESOLVED",
      resolution: "Evidence was reviewed and corrected." });
  const audit = await fixture.database.query<{ count: number }>(`SELECT count(*)::INTEGER count
    FROM audit_logs WHERE action='CANDIDATE_DISPUTE_RESOLVED' AND target_id=$1
      AND previous_value::TEXT NOT LIKE '%Incorrect detection%'
      AND new_value::TEXT NOT LIKE '%Evidence was reviewed%'`, [disputeId]);
  return { disputeId, reviewed, overview, resolved, auditCount: audit.rows[0]!.count };
}

export function organizationInput(userId: string, domain: string) {
  return { userId, name: domain.split(".")[0], domain, jobRole: "Founder", timezone: "UTC",
    companySize: "1-10", expectedMonthlyInterviews: 10 };
}

export function loadMigrations(include: (file: string) => boolean = () => true) {
  const directory = resolve(process.cwd(), "../../infrastructure/postgres");
  return readdirSync(directory).filter((file) => /^\d+.*\.sql$/.test(file) && include(file)).sort()
    .map((file) => readFileSync(resolve(directory, file), "utf8")).join("\n");
}

export async function rpc<T>(database: PGlite, name: string,
  input: Record<string, unknown> = {}) {
  const result = await database.query<{ result: T }>(`SELECT ${name}($1::jsonb) AS result`,
    [JSON.stringify(input)]);
  return result.rows[0]!.result;
}
