import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test("calendar migration reconciles legacy organization connections", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    await database.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY)");
    await database.exec(loadMigrations(1, 10));
    const user = await rpc<{ id: string }>(database, "authenti8_create_user", {
      email: "upgrade@example.com", fullName: "Upgrade Owner",
    });
    await database.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [user.id]);
    const created = await rpc<{ organization: { id: string } }>(
      database, "authenti8_create_organization", {
        userId: user.id, name: "Upgrade Co", domain: "upgrade.example.com",
        jobRole: "FOUNDER", companySize: "1-10", expectedMonthlyInterviews: 0, timezone: "UTC",
      },
    );
    await database.query(`INSERT INTO google_integrations(organization_id, connected_user_id,
      google_subject, connected_email, encrypted_refresh_token, status, updated_at) VALUES
      ($1, $2, 'old-active', 'old@example.com', 'old-token', 'ACTIVE', now() - interval '1 day'),
      ($1, $2, 'new-active', 'new@example.com', 'new-token', 'ACTIVE', now())`,
    [created.organization.id, user.id]);
    await database.exec(loadMigrations(11, 11));
    const remaining = await database.query<{ google_subject: string }>(
      "SELECT google_subject FROM google_integrations WHERE organization_id = $1",
      [created.organization.id],
    );
    assert.deepEqual(remaining.rows, [{ google_subject: "new-active" }]);
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

function loadMigrations(first: number, last: number) {
  const directory = resolve(process.cwd(), "../../infrastructure/postgres");
  return readdirSync(directory).filter((file) => {
    const version = Number(file.slice(0, 3));
    return file.endsWith(".sql") && version >= first && version <= last;
  }).sort().map((file) => readFileSync(resolve(directory, file), "utf8")).join("\n");
}
