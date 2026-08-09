import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test("Starter upgrade preserves an inactive pilot subscription", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    await database.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY)");
    await database.exec(loadMigrations("011_google_calendar_sync.sql"));
    const user = await rpc<{ id: string }>(database, "authenti8_create_user", {
      email: "inactive-pilot@example.com", fullName: "Inactive Owner",
    });
    await database.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [user.id]);
    const created = await rpc<{ organization: { id: string } }>(database,
      "authenti8_create_organization", organizationInput(user.id));
    await database.query(`UPDATE subscriptions SET plan_key = 'PILOT', status = 'PAST_DUE'
      WHERE organization_id = $1`, [created.organization.id]);
    await database.query("DELETE FROM credit_transactions WHERE organization_id = $1",
      [created.organization.id]);
    await database.exec(readFileSync(resolve(migrationsDirectory(),
      "012_starter_onboarding_upgrade.sql"), "utf8"));
    const subscription = await database.query<{ plan_key: string; status: string }>(
      "SELECT plan_key, status FROM subscriptions WHERE organization_id = $1",
      [created.organization.id],
    );
    const credits = await database.query<{ count: number }>(
      "SELECT count(*)::INTEGER AS count FROM credit_transactions WHERE organization_id = $1",
      [created.organization.id],
    );
    assert.deepEqual(subscription.rows[0], { plan_key: "STARTER", status: "PAST_DUE" });
    assert.equal(Number(credits.rows[0]?.count), 0);
  } finally {
    await database.close();
  }
});

async function rpc<T>(database: PGlite, name: string, input: object) {
  const result = await database.query<{ value: T }>(
    `SELECT ${name}($1::jsonb) AS value`, [JSON.stringify(input)],
  );
  return result.rows[0]!.value;
}

function organizationInput(userId: string) {
  return { userId, name: "Inactive Pilot", domain: "inactive.example.com",
    jobRole: "FOUNDER", companySize: "1-10", expectedMonthlyInterviews: 0,
    timezone: "UTC" };
}

function migrationsDirectory() {
  return resolve(process.cwd(), "../../infrastructure/postgres");
}

function loadMigrations(lastFile: string) {
  return readdirSync(migrationsDirectory()).filter((file) => file.endsWith(".sql"))
    .sort().filter((file) => file <= lastFile)
    .map((file) => readFileSync(resolve(migrationsDirectory(), file), "utf8")).join("\n");
}
