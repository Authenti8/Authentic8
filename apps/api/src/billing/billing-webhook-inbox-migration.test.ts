import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test("Dodo deliveries are durably claimed, retried, and completed", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    await database.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY)");
    await database.exec(loadMigrations());
    const envelope = { eventId: "event-inbox-1", eventType: "payment.succeeded",
      payload: { id: "event-inbox-1", type: "payment.succeeded", data: {} } };
    assert.deepEqual(await rpc(database, "authenti8_enqueue_billing_webhook", envelope),
      { accepted: true, duplicate: false });
    assert.deepEqual(await rpc(database, "authenti8_enqueue_billing_webhook", envelope),
      { accepted: true, duplicate: true });
    const first = await claim(database);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.eventId, envelope.eventId);
    assert.deepEqual(await claim(database), []);
    await complete(database, first[0]!, false);
    assert.deepEqual(await claim(database), []);
    await database.query("UPDATE billing_webhook_inbox SET available_at = now()");
    const retry = await claim(database);
    assert.equal(retry.length, 1);
    assert.notEqual(retry[0]?.claimToken, first[0]?.claimToken);
    await complete(database, retry[0]!, true);
    assert.deepEqual(await claim(database), []);
    const status = await database.query<{ status: string; attempt_count: number }>(
      "SELECT status, attempt_count FROM billing_webhook_inbox WHERE event_id = $1",
      [envelope.eventId],
    );
    assert.deepEqual(status.rows[0], { status: "PROCESSED", attempt_count: 2 });
  } finally {
    await database.close();
  }
});

test("permanently failing Dodo deliveries enter the dead-letter state", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    await database.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY)");
    await database.exec(loadMigrations());
    const envelope = { eventId: "event-dead-letter", eventType: "payment.succeeded",
      payload: { id: "event-dead-letter", type: "payment.succeeded", data: {} } };
    await rpc(database, "authenti8_enqueue_billing_webhook", envelope);
    await database.query(
      "UPDATE billing_webhook_inbox SET attempt_count = 9 WHERE event_id = $1",
      [envelope.eventId],
    );
    const job = (await claim(database))[0]!;
    await complete(database, job, false);
    await database.query("UPDATE billing_webhook_inbox SET available_at = now()");
    assert.deepEqual(await claim(database), []);
    const result = await database.query<{ status: string; attempt_count: number;
      last_error_code: string }>(
      `SELECT status, attempt_count, last_error_code FROM billing_webhook_inbox
       WHERE event_id = $1`, [envelope.eventId],
    );
    assert.deepEqual(result.rows[0], { status: "DEAD_LETTER", attempt_count: 10,
      last_error_code: "TEST_ERROR" });
  } finally {
    await database.close();
  }
});

test("a crashed Dodo worker cannot bypass the dead-letter attempt limit", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    await database.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY)");
    await database.exec(loadMigrations());
    const envelope = { eventId: "event-crashed-worker", eventType: "payment.succeeded",
      payload: { id: "event-crashed-worker", type: "payment.succeeded", data: {} } };
    await rpc(database, "authenti8_enqueue_billing_webhook", envelope);
    await database.query(
      "UPDATE billing_webhook_inbox SET attempt_count = 9 WHERE event_id = $1",
      [envelope.eventId],
    );
    assert.equal((await claim(database)).length, 1);
    await database.query(
      `UPDATE billing_webhook_inbox SET locked_at = now() - interval '6 minutes'
       WHERE event_id = $1`, [envelope.eventId],
    );
    assert.deepEqual(await claim(database), []);
    const result = await database.query<{ status: string; attempt_count: number;
      last_error_code: string }>(
      `SELECT status, attempt_count, last_error_code FROM billing_webhook_inbox
       WHERE event_id = $1`, [envelope.eventId],
    );
    assert.deepEqual(result.rows[0], { status: "DEAD_LETTER", attempt_count: 10,
      last_error_code: "WORKER_TIMEOUT" });
  } finally {
    await database.close();
  }
});

type Job = { eventId: string; claimToken: string; payload: unknown };

function claim(database: PGlite) {
  return rpc<Job[]>(database, "authenti8_claim_billing_webhooks", {});
}

function complete(database: PGlite, job: Job, success: boolean) {
  return rpc(database, "authenti8_complete_billing_webhook", {
    eventId: job.eventId, claimToken: job.claimToken, success, errorCode: "TEST_ERROR",
  });
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
