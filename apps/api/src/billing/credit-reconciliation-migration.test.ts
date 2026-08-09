import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test("refunds and plan downgrades release excess reservations", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const fixture = await createFixture(database);
    await assertRefundTrim(database, fixture);
    await assertDowngradeTrim(database, fixture);
  } finally {
    await database.close();
  }
});

test("reconciliation restores entitlement releases but preserves intentional releases", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const fixture = await createFixture(database);
    const later = [];
    for (let day = 10; day < 20; day += 1) {
      later.push(await createInterviewAt(database, fixture.organizationId, day));
    }
    const earliest = await createInterviewAt(database, fixture.organizationId, 1);
    assert.equal(await reservationStatus(database, earliest), null);

    await rpc(database, "authenti8_reconcile_all_credits", {});
    assert.equal(await reservationStatus(database, earliest), "RESERVED");
    assert.equal(await protectionStatus(database, earliest), "RESERVED");
    assert.equal(await reservationStatus(database, later.at(-1)!), "RELEASED");
    assert.equal(await protectionStatus(database, later.at(-1)!), "UNPROTECTED_NO_CREDITS");

    await database.query(`UPDATE credit_reservations SET status = 'RELEASED',
      released_at = now(), release_reason = 'ENTITLEMENT' WHERE interview_id = $1`, [earliest]);
    assert.equal(await reservationStatus(database, earliest), "RELEASED");
    await rpc(database, "authenti8_reconcile_all_credits", {});
    assert.equal(await reservationStatus(database, earliest), "RESERVED");

    await rpc(database, "authenti8_release_credit", { interviewId: earliest });
    await rpc(database, "authenti8_reconcile_all_credits", {});
    assert.equal(await reservationStatus(database, earliest), "RELEASED");
    assert.equal(await protectionStatus(database, earliest), "RELEASED");
    await database.query(`UPDATE interviews SET scheduled_start = scheduled_start + interval '1 minute'
      WHERE id = $1`, [earliest]);
    assert.equal(await reservationStatus(database, earliest), "RELEASED");
    assert.equal(await reservationReason(database, earliest), "MANUAL");

    const restorable = later[0]!;
    await database.query("UPDATE interviews SET status = 'CANCELLED' WHERE id = $1", [restorable]);
    assert.equal(await reservationStatus(database, restorable), "RELEASED");
    assert.equal(await reservationReason(database, restorable), "INELIGIBLE");
    await database.query("UPDATE interviews SET status = 'DETECTED' WHERE id = $1", [restorable]);
    await rpc(database, "authenti8_reconcile_all_credits", {});
    assert.equal(await reservationStatus(database, restorable), "RESERVED");
    assert.equal(await protectionStatus(database, restorable), "RESERVED");
  } finally {
    await database.close();
  }
});

test("scheduled cleanup reconciles only organizations with expired reservations", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const fixture = await createFixture(database);
    const expired = await createInterviewAt(database, fixture.organizationId, 1);
    const future = await createInterviewAt(database, fixture.organizationId, 2);
    await database.exec("ALTER TABLE interviews DISABLE TRIGGER authenti8_interview_credit_update");
    await database.query(`UPDATE interviews SET scheduled_start = now() - interval '2 hours',
      scheduled_end = now() - interval '1 hour' WHERE id = $1`, [expired]);
    await database.exec("ALTER TABLE interviews ENABLE TRIGGER authenti8_interview_credit_update");

    assert.equal(await reservationStatus(database, expired), "RESERVED");
    assert.deepEqual(await rpc(database, "authenti8_reconcile_expired_credits", {}),
      { examined: 1 });
    assert.equal(await reservationStatus(database, expired), "RELEASED");
    assert.equal(await protectionStatus(database, expired), "RELEASED");
    assert.equal(await reservationStatus(database, future), "RESERVED");
    assert.deepEqual(await rpc(database, "authenti8_reconcile_expired_credits", {}),
      { examined: 0 });
  } finally {
    await database.close();
  }
});

test("reconciliation preserves a reservation during the monitoring overrun window", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const fixture = await createFixture(database);
    const interview = await createInterviewAt(database, fixture.organizationId, 1);
    await database.exec("ALTER TABLE interviews DISABLE TRIGGER authenti8_interview_credit_update");
    await database.query(`UPDATE interviews SET scheduled_start = now() - interval '70 minutes',
      scheduled_end = now() - interval '10 minutes' WHERE id = $1`, [interview]);
    await database.exec("ALTER TABLE interviews ENABLE TRIGGER authenti8_interview_credit_update");

    await rpc(database, "authenti8_reconcile_all_credits", {});
    assert.equal(await reservationStatus(database, interview), "RESERVED");
    assert.deepEqual(await rpc(database, "authenti8_consume_credit", {
      interviewId: interview,
    }), { consumed: true });
    assert.equal(await reservationStatus(database, interview), "CONSUMED");
    assert.equal(await protectionStatus(database, interview), "CONSUMED");
  } finally {
    await database.close();
  }
});

async function assertRefundTrim(database: PGlite, fixture: Fixture) {
  const checkout = await beginCheckout(database, fixture.userId, "EXTRA_CREDITS", 1);
  await applyEvent(database, fixture, { eventId: "trim-payment-event",
    eventType: "payment.succeeded", purpose: "EXTRA_CREDITS", quantity: 1,
    checkoutIntentId: checkout, paymentId: "trim-payment", amountMinor: 500, currency: "USD" });
  await createInterviews(database, fixture.organizationId, 11, 700);
  assert.equal(await reservationCount(database, fixture.organizationId), 11);
  await rpc(database, "authenti8_apply_billing_reversal", { eventId: "trim-refund-event",
    eventType: "refund.succeeded", paymentId: "trim-payment", reversalId: "trim-refund",
    amountMinor: 500, occurredAt: new Date().toISOString() });
  assert.equal(await reservationCount(database, fixture.organizationId), 10);
  assert.equal(await balance(database, fixture.userId), 0);
}

async function assertDowngradeTrim(database: PGlite, fixture: Fixture) {
  const checkout = await beginCheckout(database, fixture.userId, "PROFESSIONAL", 1);
  const periodStart = new Date().toISOString();
  const periodEnd = new Date(Date.now() + 30 * 86400_000).toISOString();
  await applyEvent(database, fixture, { eventId: "trim-professional-active",
    eventType: "subscription.active", purpose: "PROFESSIONAL", quantity: 1,
    subscriptionId: "trim-subscription", checkoutIntentId: checkout,
    occurredAt: periodStart, periodStart, periodEnd });
  await createInterviews(database, fixture.organizationId, 5, 800);
  assert.equal(await reservationCount(database, fixture.organizationId), 16);
  await applyEvent(database, fixture, { eventId: "trim-professional-cancelled",
    eventType: "subscription.cancelled", purpose: "PROFESSIONAL", quantity: 1,
    subscriptionId: "trim-subscription", occurredAt: new Date(Date.now() + 1000).toISOString() });
  assert.equal(await reservationCount(database, fixture.organizationId), 10);
  assert.equal(await balance(database, fixture.userId), 0);
}

async function createFixture(database: PGlite): Promise<Fixture> {
  await database.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY)");
  await database.exec(loadMigrations());
  const user = await rpc<{ id: string }>(database, "authenti8_create_user", {
    email: "reconciliation@example.com", fullName: "Reconciliation Owner",
  });
  await database.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [user.id]);
  const created = await rpc<{ organization: { id: string } }>(
    database, "authenti8_create_organization", { userId: user.id, name: "Reconciliation Co",
      domain: "reconciliation.example.com", jobRole: "FOUNDER", companySize: "1-10",
      expectedMonthlyInterviews: 0, timezone: "UTC" },
  );
  return { userId: user.id, organizationId: created.organization.id };
}

async function beginCheckout(
  database: PGlite, userId: string, purpose: string, quantity: number,
) {
  const checkout = await rpc<{ checkoutIntentId: string }>(database,
    "authenti8_begin_checkout", { userId, purpose, quantity });
  await rpc(database, "authenti8_complete_checkout_intent", {
    userId, checkoutIntentId: checkout.checkoutIntentId, sessionId: `trim-${purpose}`,
  });
  return checkout.checkoutIntentId;
}

function applyEvent(database: PGlite, fixture: Fixture, event: Record<string, unknown>) {
  return rpc(database, "authenti8_apply_billing_event", {
    organizationId: fixture.organizationId, occurredAt: new Date().toISOString(), ...event,
  });
}

async function createInterviews(
  database: PGlite, organizationId: string, count: number, offset: number,
) {
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    await database.query(`INSERT INTO interviews(id, organization_id, google_event_id,
      google_calendar_id, google_meet_code, google_meet_url, candidate_email,
      organizer_email, title, scheduled_start, scheduled_end)
      VALUES ($1, $2, $3, 'primary', $3, 'https://meet.google.com/abc-defg-hij',
        'candidate@example.com', 'owner@example.com', 'Interview', now(), now() + interval '1 hour')`,
    [id, organizationId, `trim-event-${offset + index}`]);
  }
}

async function createInterviewAt(database: PGlite, organizationId: string, day: number) {
  const id = randomUUID();
  const start = new Date(Date.now() + day * 86400_000);
  const end = new Date(start.getTime() + 3600_000);
  await database.query(`INSERT INTO interviews(id, organization_id, google_event_id,
    google_calendar_id, google_meet_code, google_meet_url, candidate_email,
    organizer_email, title, scheduled_start, scheduled_end)
    VALUES ($1, $2, $3, 'primary', $3, 'https://meet.google.com/abc-defg-hij',
      'candidate@example.com', 'owner@example.com', 'Interview', $4, $5)`,
  [id, organizationId, `priority-event-${day}`, start.toISOString(), end.toISOString()]);
  return id;
}

async function reservationStatus(database: PGlite, interviewId: string) {
  const result = await database.query<{ status: string }>(
    "SELECT status FROM credit_reservations WHERE interview_id = $1", [interviewId],
  );
  return result.rows[0]?.status ?? null;
}

async function protectionStatus(database: PGlite, interviewId: string) {
  const result = await database.query<{ protection_status: string }>(
    "SELECT protection_status FROM interviews WHERE id = $1", [interviewId],
  );
  return result.rows[0]?.protection_status ?? null;
}

async function reservationReason(database: PGlite, interviewId: string) {
  const result = await database.query<{ release_reason: string | null }>(
    "SELECT release_reason FROM credit_reservations WHERE interview_id = $1", [interviewId],
  );
  return result.rows[0]?.release_reason ?? null;
}

async function reservationCount(database: PGlite, organizationId: string) {
  const result = await database.query<{ count: number }>(
    "SELECT count(*)::INTEGER AS count FROM credit_reservations WHERE organization_id = $1 AND status = 'RESERVED'",
    [organizationId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function balance(database: PGlite, userId: string) {
  return (await rpc<{ balance: number }>(
    database, "authenti8_billing_summary", { userId },
  )).balance;
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

type Fixture = { userId: string; organizationId: string };
