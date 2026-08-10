import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { advanceToDeviceConnecting } from "../billing/billing-provider-routing.helper.test.js";

test("calendar channels authenticate, renew, and restore requalified events", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const fixture = await createFixture(database);
    const integration = await rpc<{ id: string; generation: number }>(database,
      "authenti8_upsert_google_integration", integrationInput(fixture));
    await rpc(database, "authenti8_store_calendar_channel", {
      integrationId: integration.id, generation: integration.generation,
      channelId: "channel-1", resourceId: "resource-1",
      channelTokenHash: "expected-hash", expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(await rpc(database, "authenti8_channel_credentials", {
      channelId: "channel-1", channelTokenHash: "wrong-hash",
    }), null);
    const credentials = await rpc<{ id: string }>(database, "authenti8_channel_credentials", {
      channelId: "channel-1", channelTokenHash: "expected-hash",
    });
    assert.equal(credentials.id, integration.id);
    const due = await rpc<Array<{ id: string }>>(database, "authenti8_due_calendar_channels", {});
    assert.deepEqual(due.map((item) => item.id), [integration.id]);
    assert.deepEqual(await rpc(database, "authenti8_due_calendar_channels", {}), []);
    await assertWatchRegistrationHealth(database, integration.id, integration.generation,
      fixture.userId);
    await assertDurableQueue(database, integration.id);
    await assertRequalification(database, integration.id, fixture);
    await assertMonitoredInterviewFrozen(database, integration.id, fixture.organizationId);
    await assertDashboardHealth(database, fixture);
    await assertDashboardReports(database, fixture);
    await assertMemberCannotManageIntegration(database, integration.id, fixture.organizationId);
    await assertReconnectAndDisconnect(database, integration.id, fixture);
  } finally {
    await database.close();
  }
});

async function assertWatchRegistrationHealth(
  database: PGlite, integrationId: string, generation: number, userId: string,
) {
  await rpc(database, "authenti8_mark_calendar_watch_error", {
    integrationId, generation, errorCode: "WATCH_REGISTRATION_FAILED",
  });
  const degraded = await rpc<{ lastErrorCode: string }>(
    database, "authenti8_integration_summary", { userId },
  );
  assert.equal(degraded.lastErrorCode, "WATCH_REGISTRATION_FAILED");
  await rpc(database, "authenti8_store_calendar_channel", {
    integrationId, generation, channelId: "channel-1", resourceId: "resource-1",
    channelTokenHash: "expected-hash", expiresAt: new Date(Date.now() + 86400_000).toISOString(),
  });
  const recovered = await rpc<{ lastErrorCode: string | null }>(
    database, "authenti8_integration_summary", { userId },
  );
  assert.equal(recovered.lastErrorCode, null);
}

async function assertDurableQueue(database: PGlite, integrationId: string) {
  assert.deepEqual(await rpc(database, "authenti8_enqueue_calendar_sync", {
    channelId: "channel-1", channelTokenHash: "wrong-hash",
  }), { ignored: true });
  await rpc(database, "authenti8_enqueue_calendar_sync", {
    channelId: "channel-1", channelTokenHash: "expected-hash",
  });
  const first = await claimJobs(database);
  const firstJob = first[0]!;
  assert.equal(firstJob.integrationId, integrationId);
  await rpc(database, "authenti8_enqueue_calendar_sync", {
    channelId: "channel-1", channelTokenHash: "expected-hash",
  });
  assert.deepEqual(await claimJobs(database), []);
  await rpc(database, "authenti8_complete_calendar_sync_job", {
    ...firstJob, success: true, errorCode: "",
  });
  const second = await claimJobs(database);
  const secondJob = second[0]!;
  assert.equal(secondJob.integrationId, integrationId);
  await rpc(database, "authenti8_complete_calendar_sync_job", {
    ...secondJob, success: true, errorCode: "",
  });
  assert.deepEqual(await claimJobs(database), []);
  assert.deepEqual(await rpc(database, "authenti8_enqueue_calendar_sync_by_id", {
    integrationId,
  }), { queued: true });
  const direct = await claimJobs(database);
  assert.equal(direct[0]?.integrationId, integrationId);
  await rpc(database, "authenti8_enqueue_calendar_sync", {
    channelId: "channel-1", channelTokenHash: "expected-hash",
  });
  assert.deepEqual(await rpc(database, "authenti8_complete_calendar_sync_job", {
    ...direct[0]!, success: false, errorCode: "STALE_FAILURE",
  }), { completed: true, superseded: true });
  const retry = await claimJobs(database);
  assert.equal(retry[0]?.integrationId, integrationId);
  await rpc(database, "authenti8_complete_calendar_sync_job", {
    ...retry[0]!, success: true, errorCode: "",
  });
}

async function assertRequalification(
  database: PGlite, integrationId: string,
  fixture: { userId: string; organizationId: string },
) {
  const event = calendarEvent();
  await applyCalendarSync(database, integrationId, {
    integrationId, events: [event], syncToken: "sync-1",
  });
  const interviewId = await currentInterviewId(database, fixture.organizationId);
  await rpc(database, "authenti8_reserve_credit", { userId: fixture.userId, interviewId });
  const excludedAt = new Date(Date.parse(event.updatedAt) + 1000).toISOString();
  await applyCalendarSync(database, integrationId, {
    integrationId, events: [{ eventId: event.eventId, excluded: true, updatedAt: excludedAt }],
    syncToken: "sync-2",
  });
  assert.equal(await interviewStatusByEvent(
    database, fixture.organizationId, event.eventId,
  ), "EXCLUDED");
  const reservation = await database.query<{ status: string }>(
    "SELECT status FROM credit_reservations WHERE interview_id = $1", [interviewId],
  );
  assert.equal(reservation.rows[0]?.status, "RELEASED");
  await applyCalendarSync(database, integrationId, {
    integrationId, events: [{ ...event,
      updatedAt: new Date(Date.parse(event.updatedAt) + 2000).toISOString() }], syncToken: "sync-3",
  });
  assert.equal(await interviewStatus(database, fixture.organizationId), "DETECTED");
  await assertStaleEventIgnored(database, integrationId, fixture.organizationId, event);
  await rpc(database, "authenti8_reserve_credit", { userId: fixture.userId, interviewId });
  await applyCalendarSync(database, integrationId, {
    integrationId, events: [], syncToken: "sync-4", fullSync: false,
  });
  assert.equal(await interviewStatus(database, fixture.organizationId), "DETECTED");
  await assertBoundedFullSync(database, integrationId, fixture.organizationId,
    event.eventId, interviewId);
  await assertStaleSyncIgnored(database, integrationId);
  await database.query(
    "UPDATE calendar_sync_states SET last_synced_at = now() - interval '31 minutes'",
  );
  await rpc(database, "authenti8_enqueue_stale_calendar_syncs", {});
  assert.equal((await claimJobs(database))[0]?.integrationId, integrationId);
}

async function assertStaleSyncIgnored(database: PGlite, integrationId: string) {
  const newer = new Date().toISOString();
  await applyCalendarSync(database, integrationId, {
    events: [], syncToken: "newest-token", syncStartedAt: newer,
  });
  assert.deepEqual(await applyCalendarSync(database, integrationId, {
    events: [], syncToken: "older-token",
    syncStartedAt: new Date(Date.parse(newer) - 1000).toISOString(),
  }), { ignored: true, reason: "STALE_SYNC" });
  const state = await database.query<{ sync_token: string }>(
    "SELECT sync_token FROM calendar_sync_states WHERE google_integration_id = $1", [integrationId],
  );
  assert.equal(state.rows[0]?.sync_token, "newest-token");
}

async function assertMonitoredInterviewFrozen(
  database: PGlite, integrationId: string, organizationId: string,
) {
  const event = { ...calendarEvent(), eventId: "monitored-event" };
  await applyCalendarSync(database, integrationId, {
    events: [event], syncToken: "monitored-before",
  });
  const interviewId = await currentInterviewIdByEvent(database, organizationId, event.eventId);
  await advanceToDeviceConnecting(database, interviewId);
  await database.query(`UPDATE interviews SET status = 'MONITORING_ACTIVE',
    monitoring_started_at = now() WHERE id = $1`, [interviewId]);
  const before = await interviewEvidence(database, interviewId);
  await applyCalendarSync(database, integrationId, {
    events: [{ ...event, title: "Rewritten interview", candidateEmail: "other@outside.com",
      updatedAt: new Date(Date.parse(event.updatedAt) + 5000).toISOString(),
      participants: [{ email: "other@outside.com", name: "Other Candidate",
        type: "CANDIDATE", external: true }] }],
    syncToken: "monitored-after",
  });
  assert.deepEqual(await interviewEvidence(database, interviewId), before);
}

async function interviewEvidence(database: PGlite, interviewId: string) {
  const result = await database.query<{ title: string; candidate_email: string; emails: string[] }>(
    `SELECT interview.title, interview.candidate_email,
      array_agg(participant.email ORDER BY participant.email) AS emails
     FROM interviews interview JOIN interview_participants participant
       ON participant.interview_id = interview.id
     WHERE interview.id = $1 GROUP BY interview.id`, [interviewId],
  );
  return result.rows[0];
}

async function assertStaleEventIgnored(
  database: PGlite, integrationId: string, organizationId: string,
  event: ReturnType<typeof calendarEvent>,
) {
  await applyCalendarSync(database, integrationId, {
    events: [{ ...event, title: "Stale title" }], syncToken: "stale-event-sync",
  });
  await applyCalendarSync(database, integrationId, {
    events: [{ eventId: event.eventId, cancelled: true, updatedAt: event.updatedAt }],
    syncToken: "stale-tombstone-sync",
  });
  const current = await database.query<{ title: string; status: string }>(
    "SELECT title, status FROM interviews WHERE organization_id = $1 AND google_event_id = $2",
    [organizationId, event.eventId],
  );
  assert.deepEqual(current.rows[0], { title: "Interview", status: "DETECTED" });
}

async function assertBoundedFullSync(
  database: PGlite, integrationId: string, organizationId: string,
  inWindowEventId: string, interviewId: string,
) {
  const outsideWindow = { ...calendarEvent(), eventId: "event-outside-window",
    start: new Date(Date.now() + 120 * 86400_000).toISOString(),
    end: new Date(Date.now() + 120 * 86400_000 + 3600_000).toISOString() };
  await applyCalendarSync(database, integrationId, {
    integrationId, events: [outsideWindow], syncToken: "sync-5", fullSync: false,
  });
  await applyCalendarSync(database, integrationId, {
    integrationId, events: [], syncToken: "sync-6", fullSync: true,
    scanWindowStart: new Date(Date.now() - 86400_000).toISOString(),
    scanWindowEnd: new Date(Date.now() + 90 * 86400_000).toISOString(),
  });
  assert.equal(await interviewStatusByEvent(
    database, organizationId, inWindowEventId,
  ), "EXCLUDED");
  assert.equal(await interviewStatusByEvent(
    database, organizationId, outsideWindow.eventId,
  ), "DETECTED");
  const afterFullSync = await database.query<{ status: string }>(
    "SELECT status FROM credit_reservations WHERE interview_id = $1", [interviewId],
  );
  assert.equal(afterFullSync.rows[0]?.status, "RELEASED");
}

async function assertDashboardHealth(
  database: PGlite, fixture: { userId: string; organizationId: string },
) {
  const healthy = await rpc<{ integrationActive: boolean }>(
    database, "authenti8_dashboard_overview", { userId: fixture.userId },
  );
  assert.equal(healthy.integrationActive, true);
  await database.query(
    "UPDATE calendar_sync_states SET last_error_code = 'GOOGLE_500'",
  );
  const failed = await rpc<{ integrationActive: boolean }>(
    database, "authenti8_dashboard_overview", { userId: fixture.userId },
  );
  assert.equal(failed.integrationActive, false);
  await database.query("UPDATE calendar_sync_states SET last_error_code = NULL");
}

async function assertDashboardReports(
  database: PGlite, fixture: { userId: string; organizationId: string },
) {
  const interviewId = await currentInterviewId(database, fixture.organizationId);
  const report = await database.query<{ id: string }>(`INSERT INTO reports(
    interview_id, detection_result, monitoring_status, coverage_percentage, snapshot)
    VALUES ($1, 'CONFIRMED', 'COMPLETE', 100, '{}') RETURNING id`, [interviewId]);
  await advanceToDeviceConnecting(database, interviewId);
  for (const status of ["MONITORING_ACTIVE", "MEETING_COMPLETED",
    "REPORT_PROCESSING", "REPORT_READY"]) {
    await database.query("UPDATE interviews SET status = $2 WHERE id = $1", [interviewId, status]);
  }
  await database.query(`UPDATE interviews SET report_id = $2,
    scheduled_start = now() - interval '40 days', scheduled_end = now() - interval '39 days'
    WHERE id = $1`, [interviewId, report.rows[0]!.id]);
  const overview = await rpc<{ completed: number }>(database,
    "authenti8_dashboard_overview", { userId: fixture.userId });
  assert.equal(Number(overview.completed), 1);
  const meetings = await rpc<Array<{ id: string }>>(database,
    "authenti8_list_interviews", { userId: fixture.userId });
  assert.equal(meetings.some((meeting) => meeting.id === interviewId), true);
}

async function assertMemberCannotManageIntegration(
  database: PGlite, integrationId: string, organizationId: string,
) {
  const viewer = await rpc<{ id: string }>(database, "authenti8_create_user", {
    email: "viewer@example.com", fullName: "Calendar Viewer",
  });
  await database.query(
    `INSERT INTO organization_members(organization_id, user_id, role, job_role)
     VALUES ($1, $2, 'VIEWER', 'OBSERVER')`, [organizationId, viewer.id],
  );
  assert.equal(await rpc(database, "authenti8_integration_credentials", {
    userId: viewer.id,
  }), null);
  assert.deepEqual(await rpc(database, "authenti8_disconnect_google", {
    userId: viewer.id,
  }), { disconnected: false });
  const active = await database.query<{ status: string }>(
    "SELECT status FROM google_integrations WHERE id = $1", [integrationId],
  );
  assert.equal(active.rows[0]?.status, "ACTIVE");
}

async function assertReconnectAndDisconnect(
  database: PGlite, integrationId: string,
  fixture: { userId: string; organizationId: string },
) {
  const reconnectEvent = { ...calendarEvent(), eventId: "reconnect-old-event" };
  await applyCalendarSync(database, integrationId, {
    events: [reconnectEvent], syncToken: "before-reconnect",
  });
  const oldInterview = await currentInterviewIdByEvent(
    database, fixture.organizationId, reconnectEvent.eventId,
  );
  await rpc(database, "authenti8_reserve_credit", { interviewId: oldInterview });
  const beforeReconnect = await integrationVersion(database, integrationId);
  const reconnected = await rpc<{ generation: number }>(database,
    "authenti8_upsert_google_integration", {
    ...integrationInput(fixture), subject: "new-google-subject", email: "new@example.com",
    calendarId: "new-calendar",
  });
  assert.equal(await interviewStatusById(database, oldInterview), "EXCLUDED");
  const reset = await database.query<{ sync_token: string | null; channel_id: string | null }>(
    "SELECT sync_token, channel_id FROM calendar_sync_states WHERE google_integration_id = $1",
    [integrationId],
  );
  assert.deepEqual(reset.rows[0], { sync_token: null, channel_id: "channel-1" });
  assert.deepEqual(await rpc(database, "authenti8_apply_calendar_sync", {
    integrationId, generation: beforeReconnect.generation,
    calendarId: beforeReconnect.calendarId,
    events: [{ ...calendarEvent(), eventId: "stale-event" }],
    syncToken: "stale-sync", fullSync: true,
  }), { ignored: true });
  await rpc(database, "authenti8_apply_calendar_sync", {
    generation: reconnected.generation, calendarId: "new-calendar",
    integrationId, events: [{ ...calendarEvent(), eventId: "new-event" }],
    syncToken: "new-sync", fullSync: true,
  });
  const newInterview = await currentInterviewIdByCalendar(database, fixture.organizationId,
    "new-calendar");
  await rpc(database, "authenti8_reserve_credit", { interviewId: newInterview });
  await rpc(database, "authenti8_enqueue_calendar_sync_by_id", { integrationId });
  assert.deepEqual(await rpc(database, "authenti8_disconnect_google", {
    userId: fixture.userId,
  }), { disconnected: true });
  assert.equal(await interviewStatusById(database, newInterview), "EXCLUDED");
  assert.equal(await reservationStatus(database, newInterview), "RELEASED");
  assert.deepEqual(await claimJobs(database), []);
}

async function claimJobs(database: PGlite) {
  return rpc<Array<{ integrationId: string; generation: number;
    requestedAt: string; claimToken: string }>>(
    database, "authenti8_claim_calendar_sync_jobs", {},
  );
}

async function applyCalendarSync(database: PGlite, integrationId: string, input: object) {
  const version = await integrationVersion(database, integrationId);
  return rpc(database, "authenti8_apply_calendar_sync", {
    ...input, integrationId, generation: version.generation, calendarId: version.calendarId,
  });
}

async function integrationVersion(database: PGlite, integrationId: string) {
  const result = await database.query<{ connection_generation: number; selected_calendar_id: string }>(
    `SELECT connection_generation, selected_calendar_id FROM google_integrations WHERE id = $1`,
    [integrationId],
  );
  return { generation: Number(result.rows[0]!.connection_generation),
    calendarId: result.rows[0]!.selected_calendar_id };
}

async function currentInterviewId(database: PGlite, organizationId: string) {
  const result = await database.query<{ id: string }>(
    "SELECT id FROM interviews WHERE organization_id = $1", [organizationId],
  );
  return result.rows[0]!.id;
}

async function currentInterviewIdByCalendar(
  database: PGlite, organizationId: string, calendarId: string,
) {
  const result = await database.query<{ id: string }>(
    "SELECT id FROM interviews WHERE organization_id = $1 AND google_calendar_id = $2",
    [organizationId, calendarId],
  );
  return result.rows[0]!.id;
}

async function currentInterviewIdByEvent(
  database: PGlite, organizationId: string, eventId: string,
) {
  const result = await database.query<{ id: string }>(
    "SELECT id FROM interviews WHERE organization_id = $1 AND google_event_id = $2",
    [organizationId, eventId],
  );
  return result.rows[0]!.id;
}

async function interviewStatusById(database: PGlite, interviewId: string) {
  const result = await database.query<{ status: string }>(
    "SELECT status FROM interviews WHERE id = $1", [interviewId],
  );
  return result.rows[0]?.status;
}

async function interviewStatusByEvent(
  database: PGlite, organizationId: string, eventId: string,
) {
  const result = await database.query<{ status: string }>(
    `SELECT status FROM interviews
     WHERE organization_id = $1 AND google_event_id = $2`, [organizationId, eventId],
  );
  return result.rows[0]?.status;
}

async function reservationStatus(database: PGlite, interviewId: string) {
  const result = await database.query<{ status: string }>(
    "SELECT status FROM credit_reservations WHERE interview_id = $1", [interviewId],
  );
  return result.rows[0]?.status;
}

async function createFixture(database: PGlite) {
  await database.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY)");
  await database.exec(loadMigrations());
  const user = await rpc<{ id: string }>(database, "authenti8_create_user", {
    email: "calendar@example.com", fullName: "Calendar Owner",
  });
  await database.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [user.id]);
  const result = await rpc<{ organization: { id: string } }>(
    database, "authenti8_create_organization", {
      userId: user.id, name: "Calendar Co", domain: "calendar.example.com",
      jobRole: "FOUNDER", companySize: "1-10", expectedMonthlyInterviews: 0, timezone: "UTC",
    },
  );
  return { userId: user.id, organizationId: result.organization.id };
}

function integrationInput(fixture: { userId: string; organizationId: string }) {
  return { ...fixture, subject: "google-subject", email: "calendar@example.com",
    refreshToken: "encrypted-refresh", accessToken: "encrypted-access",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), calendarId: "primary",
    calendarName: "Primary calendar" };
}

function calendarEvent() {
  return { eventId: "event-1", meetCode: "abc-defg-hij",
    meetUrl: "https://meet.google.com/abc-defg-hij", candidateEmail: "candidate@outside.com",
    candidateName: "Candidate", organizerEmail: "calendar@example.com", title: "Interview",
    reason: "external candidate interview", start: new Date(Date.now() + 3600_000).toISOString(),
    end: new Date(Date.now() + 7200_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    participants: [{ email: "candidate@outside.com", name: "Candidate",
      type: "CANDIDATE", external: true }] };
}

async function interviewStatus(database: PGlite, organizationId: string) {
  const result = await database.query<{ status: string }>(
    "SELECT status FROM interviews WHERE organization_id = $1", [organizationId],
  );
  return result.rows[0]?.status;
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
