import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test("Google integration deduplication reconciles only abandoned calendars", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    await database.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY)");
    await database.exec(loadMigrations("010_billing_and_dashboard.sql"));
    const abandoned = await createScenario(database, "abandoned", "old", "kept");
    const shared = await createScenario(database, "shared", "same", "same");
    await database.exec(readMigration("011_google_calendar_sync.sql"));
    await assertScenario(database, abandoned, "EXCLUDED", "RELEASED");
    await assertScenario(database, shared, "DETECTED", "RESERVED");
  } finally {
    await database.close();
  }
});

async function createScenario(
  database: PGlite, suffix: string, discardedCalendar: string, retainedCalendar: string,
) {
  const user = await rpc<{ id: string }>(database, "authenti8_create_user", {
    email: `${suffix}@example.com`, fullName: "Migration Owner",
  });
  await database.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [user.id]);
  const created = await rpc<{ organization: { id: string } }>(
    database, "authenti8_create_organization", { userId: user.id, name: suffix,
      domain: `${suffix}.example.com`, jobRole: "FOUNDER", companySize: "1-10",
      expectedMonthlyInterviews: 0, timezone: "UTC" },
  );
  await insertIntegrations(database, created.organization.id, user.id,
    discardedCalendar, retainedCalendar);
  const interviewId = await insertInterview(database, created.organization.id, discardedCalendar);
  await rpc(database, "authenti8_reserve_credit", { interviewId });
  return { organizationId: created.organization.id, interviewId };
}

async function insertIntegrations(
  database: PGlite, organizationId: string, userId: string,
  discardedCalendar: string, retainedCalendar: string,
) {
  await database.query(`INSERT INTO google_integrations(organization_id, connected_user_id,
    google_subject, connected_email, encrypted_refresh_token, selected_calendar_id, updated_at)
    VALUES ($1, $2, 'discarded', 'owner@example.com', 'token', $3,
      now() - interval '1 day'),
      ($1, $2, 'retained', 'owner@example.com', 'token', $4, now())`,
  [organizationId, userId, discardedCalendar, retainedCalendar]);
}

async function insertInterview(database: PGlite, organizationId: string, calendarId: string) {
  const interviewId = randomUUID();
  await database.query(`INSERT INTO interviews(id, organization_id, google_event_id,
    google_calendar_id, google_meet_code, google_meet_url, candidate_email, organizer_email,
    title, scheduled_start, scheduled_end) VALUES ($1, $2, 'event', $3, 'abc-defg-hij',
    'https://meet.google.com/abc-defg-hij', 'candidate@example.com', 'owner@example.com',
    'Interview', now() + interval '1 hour', now() + interval '2 hours')`,
  [interviewId, organizationId, calendarId]);
  return interviewId;
}

async function assertScenario(
  database: PGlite, scenario: { organizationId: string; interviewId: string },
  interviewStatus: string, reservationStatus: string,
) {
  const integration = await database.query<{ count: number }>(
    "SELECT count(*)::INTEGER AS count FROM google_integrations WHERE organization_id = $1",
    [scenario.organizationId],
  );
  const state = await database.query<{ interview_status: string; reservation_status: string }>(
    `SELECT interview.status AS interview_status, reservation.status AS reservation_status
      FROM interviews interview JOIN credit_reservations reservation
        ON reservation.interview_id = interview.id WHERE interview.id = $1`, [scenario.interviewId],
  );
  assert.equal(integration.rows[0]?.count, 1);
  assert.deepEqual(state.rows[0], {
    interview_status: interviewStatus, reservation_status: reservationStatus,
  });
}

async function rpc<T = unknown>(database: PGlite, name: string, input: object) {
  const result = await database.query<{ value: T }>(
    `SELECT ${name}($1::jsonb) AS value`, [JSON.stringify(input)],
  );
  return result.rows[0]!.value;
}

function loadMigrations(lastFile: string) {
  const directory = resolve(process.cwd(), "../../infrastructure/postgres");
  return readdirSync(directory).filter((file) => file.endsWith(".sql") && file <= lastFile)
    .sort().map((file) => readFileSync(resolve(directory, file), "utf8")).join("\n");
}

function readMigration(file: string) {
  return readFileSync(resolve(process.cwd(), "../../infrastructure/postgres", file), "utf8");
}
