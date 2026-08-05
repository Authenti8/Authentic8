import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { DataType, newDb } from "pg-mem";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import request from "supertest";
import { AppModule } from "../app.module.js";
import { configureApplication } from "../application.js";
import { loadConfig } from "../config.js";
import { DatabaseService } from "../database/database.service.js";

process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.DATABASE_URL ??= "postgresql://integration.invalid/authenti8";

type Harness = { app: INestApplication; database: TestDatabase };
const activeHarnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(activeHarnesses.splice(0).map(async ({ app, database }) => {
    await app.close();
    await database.close();
  }));
});

test("signup, verification, onboarding, session, and logout work over HTTP", async () => {
  const { app, database } = await createHarness();
  const http = request(app.getHttpServer());
  const invalid = await http.post("/v1/auth/signup").send({
    email: "missing-name@example.com",
    password: "ValidPassphrase123!",
  });
  assert.equal(invalid.status, 400);
  const crossOrigin = await http.post("/v1/auth/signup")
    .set("Origin", "https://attacker.example").send(validSignup());
  assert.equal(crossOrigin.status, 403);

  const signup = await http.post("/v1/auth/signup").send(validSignup());
  assert.equal(signup.status, 201);
  const token = new URL(signup.body.previewUrl as string).searchParams.get("token");
  assert.ok(token);

  const verification = await http.post("/v1/auth/verify-email")
    .send({ token, password: validSignup().password });
  assert.equal(verification.status, 201);
  const cookie = responseCookie(verification.headers["set-cookie"], "authenti8_session");
  const before = await http.get("/v1/auth/session").set("Cookie", cookie);
  assert.equal(before.status, 200);
  assert.equal(before.body.organization, null);

  const organization = await http.post("/v1/organizations")
    .set("Cookie", cookie).send(validOrganization());
  assert.equal(organization.status, 201);
  const duplicate = await http.post("/v1/organizations")
    .set("Cookie", cookie).send({ ...validOrganization(), domain: "other.example.com" });
  assert.equal(duplicate.status, 409);

  await database.query("UPDATE users SET status = 'SUSPENDED' WHERE normalized_email = $1", [
    validSignup().email,
  ]);
  assert.equal((await http.get("/v1/auth/session").set("Cookie", cookie)).status, 401);
  await database.query("UPDATE users SET status = 'ACTIVE' WHERE normalized_email = $1", [
    validSignup().email,
  ]);
  const logout = await http.post("/v1/auth/logout").set("Cookie", cookie).send({});
  assert.equal(logout.status, 201);
  assert.equal((await http.get("/v1/auth/session").set("Cookie", cookie)).status, 401);
});

test("email verification is bound to the matching signup password", async () => {
  const { app } = await createHarness();
  const http = request(app.getHttpServer());
  const victimEmail = "flow-owner@example.com";
  const attackerPassword = "AttackerPassphrase123!";
  const victimPassword = "VictimPassphrase456!";
  const attacker = await http.post("/v1/auth/signup").send({
    fullName: "Attacker Choice", email: victimEmail, password: attackerPassword,
  });
  const victim = await http.post("/v1/auth/signup").send({
    fullName: "Victim Choice", email: victimEmail, password: victimPassword,
  });
  const attackerToken = tokenFromPreview(attacker.body.previewUrl);
  const victimToken = tokenFromPreview(victim.body.previewUrl);
  const mismatched = await http.post("/v1/auth/verify-email")
    .send({ token: attackerToken, password: victimPassword });
  assert.equal(mismatched.status, 400);
  const verified = await http.post("/v1/auth/verify-email")
    .send({ token: victimToken, password: victimPassword });
  assert.equal(verified.status, 201);
  assert.equal((await loginAttempt(http, "203.0.113.30", attackerPassword, victimEmail)).status, 401);
  assert.equal((await loginAttempt(http, "203.0.113.31", victimPassword, victimEmail)).status, 201);
});

test("Google login sets browser-bound state and IP limits are enforced", async () => {
  const { app, database } = await createHarness();
  const http = request(app.getHttpServer());
  const google = await http.get("/v1/auth/google?next=/dashboard/meetings").redirects(0);
  assert.equal(google.status, 302);
  assert.match(
    responseCookie(google.headers["set-cookie"], "authenti8_oauth_state"),
    /authenti8_oauth_state=/,
  );
  const googleLocation = google.headers.location;
  assert.ok(googleLocation);
  const state = new URL(googleLocation).searchParams.get("state");
  assert.ok(state);
  const rejected = await http.get(
    `/v1/auth/google/callback?code=attacker-code&state=${encodeURIComponent(state)}`,
  ).redirects(0);
  const rejectedLocation = rejected.headers.location;
  assert.ok(rejectedLocation);
  assert.match(rejectedLocation, /google_failed/);
  const oauthState = await database.query<{ consumed_at: Date | null; return_path: string | null }>(
    "SELECT consumed_at, return_path FROM oauth_states",
  );
  assert.equal(oauthState.rows[0]?.consumed_at, null);
  assert.equal(oauthState.rows[0]?.return_path, "/dashboard/meetings");

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const login = await loginAttempt(http, "203.0.113.10");
    assert.equal(login.status, 401);
  }
  const limited = await loginAttempt(http, "203.0.113.10");
  assert.equal(limited.status, 429);
});

test("password reset is single-use and revokes existing sessions", async () => {
  const { app, database } = await createHarness();
  const http = request(app.getHttpServer());
  const signup = await http.post("/v1/auth/signup").send(validSignup());
  const verificationToken = tokenFromPreview(signup.body.previewUrl);
  const verification = await http.post("/v1/auth/verify-email")
    .send({ token: verificationToken, password: validSignup().password });
  const oldSession = responseCookie(verification.headers["set-cookie"], "authenti8_session");
  const forgot = await http.post("/v1/auth/forgot-password")
    .send({ email: validSignup().email });
  const resetToken = tokenFromPreview(forgot.body.previewUrl);
  const cooldown = await http.post("/v1/auth/forgot-password")
    .send({ email: validSignup().email });
  assert.equal(cooldown.body.previewUrl, undefined);
  await database.query(
    "UPDATE password_reset_tokens SET created_at = now() - interval '3 minutes'",
  );
  const replacementRequest = await http.post("/v1/auth/forgot-password")
    .send({ email: validSignup().email });
  assert.ok(tokenFromPreview(replacementRequest.body.previewUrl));
  const reset = await http.post("/v1/auth/reset-password")
    .send({ token: resetToken, password: "ReplacementPassphrase456!" });
  assert.equal(reset.status, 201);
  assert.equal((await http.get("/v1/auth/session").set("Cookie", oldSession)).status, 401);
  const replay = await http.post("/v1/auth/reset-password")
    .send({ token: resetToken, password: "AnotherPassphrase789!" });
  assert.equal(replay.status, 400);
  const email = validSignup().email;
  assert.equal((await loginAttempt(http, "203.0.113.210", validSignup().password, email)).status, 401);
  assert.equal((await loginAttempt(http, "203.0.113.211", "ReplacementPassphrase456!", email)).status, 201);
});

test("suspension invalidates already-issued password reset tokens", async () => {
  const { app, database } = await createHarness();
  const http = request(app.getHttpServer());
  const signup = await http.post("/v1/auth/signup").send(validSignup());
  const verificationToken = tokenFromPreview(signup.body.previewUrl);
  await http.post("/v1/auth/verify-email")
    .send({ token: verificationToken, password: validSignup().password });
  const forgot = await http.post("/v1/auth/forgot-password")
    .send({ email: validSignup().email });
  const resetToken = tokenFromPreview(forgot.body.previewUrl);
  await database.query("UPDATE users SET status = 'SUSPENDED'");
  const suspended = await http.post("/v1/auth/reset-password")
    .send({ token: resetToken, password: "ReplacementPassphrase456!" });
  assert.equal(suspended.status, 400);
  await database.query("UPDATE users SET status = 'ACTIVE'");
  const replay = await http.post("/v1/auth/reset-password")
    .send({ token: resetToken, password: "ReplacementPassphrase456!" });
  assert.equal(replay.status, 400);
});

test("email actions are not globally locked by requests from other clients", async () => {
  const { app } = await createHarness();
  const http = request(app.getHttpServer());
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await http.post("/v1/auth/forgot-password")
      .set("X-Forwarded-For", `203.0.113.${100 + attempt}`)
      .send({ email: "target@example.com" });
    assert.equal(response.status, 201);
  }
});

test("the complete production migration enables backend RLS", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const migrations = loadProductionMigrations();
    await database.exec(migrations);
    const expectedTables = productionTableNames(migrations);
    const protectedTables = await database.query<{ table_name: string }>(rlsTablesQuery);
    assert.deepEqual(protectedTables.rows.map((row) => row.table_name).sort(), expectedTables);
    const role = await database.query<{ safe: boolean }>(backendRoleQuery);
    assert.equal(role.rows[0]?.safe, true);
    const privileges = await database.query<{ safe: boolean }>(backendPrivilegesQuery);
    assert.equal(privileges.rows[0]?.safe, true);
    await assertTenantBoundary(database);
  } finally {
    await database.close();
  }
});

test("tenant hardening preserves an existing runtime login role", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const migrations = loadProductionMigrationFiles();
    await database.exec(migrations.slice(0, 2).join("\n"));
    await database.exec("ALTER ROLE authenti8_backend LOGIN");
    await database.exec(migrations.slice(2).join("\n"));
    const role = await database.query<{ rolcanlogin: boolean }>(
      "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'authenti8_backend'",
    );
    assert.equal(role.rows[0]?.rolcanlogin, true);
  } finally {
    await database.close();
  }
});

async function createHarness() {
  const database = await TestDatabase.create();
  const testingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseService).useValue(database).compile();
  const app = testingModule.createNestApplication<NestExpressApplication>();
  configureApplication(app, loadConfig());
  await app.listen(0, "127.0.0.1");
  const harness = { app, database };
  activeHarnesses.push(harness);
  return harness;
}

class TestDatabase {
  private constructor(private readonly pool: Pool) {}

  static async create() {
    const memory = newDb();
    memory.registerExtension("pgcrypto", (schema) => {
      schema.registerFunction({
        name: "gen_random_uuid",
        returns: DataType.uuid,
        implementation: randomUUID,
        impure: true,
      });
    });
    memory.public.none(loadPgMemMigration());
    const adapter = memory.adapters.createPg();
    return new TestDatabase(new adapter.Pool() as unknown as Pool);
  }

  query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
    return this.pool.query<T>(text, values);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

function validSignup() {
  return {
    fullName: "Integration Founder",
    email: "founder@example.com",
    password: "ValidPassphrase123!",
  };
}

function validOrganization() {
  return {
    name: "Integration Labs",
    domain: "integration.example.com",
    jobRole: "Founder",
    companySize: "1-10",
    expectedMonthlyInterviews: 12,
    timezone: "Asia/Kolkata",
  };
}

function responseCookie(value: string[] | string | undefined, name: string) {
  const headers = Array.isArray(value) ? value : value ? [value] : [];
  const header = headers.find((candidate) => candidate.startsWith(`${name}=`));
  assert.ok(header);
  return header.split(";", 1)[0]!;
}

function loadProductionMigrations() {
  return loadProductionMigrationFiles().join("\n");
}

function loadProductionMigrationFiles() {
  const directory = resolve(process.cwd(), "../../infrastructure/postgres");
  return readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(resolve(directory, file), "utf8"));
}

function loadPgMemMigration() {
  return loadProductionMigrations()
    .replace(
      /-- BEGIN AUTH EMAIL OUTBOX[\s\S]*?-- END AUTH EMAIL OUTBOX/g,
      "-- The email outbox is exercised by the PGlite migration test.",
    )
    .replace(
      /DO \$\$[\s\S]*?ENABLE ROW LEVEL SECURITY[\s\S]*?END \$\$;/,
      "-- Initial RLS is exercised by the PGlite migration test.",
    )
    .replace(
      /-- BEGIN BACKEND ROLE AND RLS[\s\S]*?-- END BACKEND ROLE AND RLS/,
      "-- Backend policy is exercised by the PGlite migration test.",
    )
    .replace(
      /-- BEGIN TENANT BOUNDARIES[\s\S]*?-- END TENANT BOUNDARIES/,
      "-- Tenant boundaries are exercised by the PGlite migration test.",
    )
    .replace(
      /-- BEGIN ONBOARDING BOUNDARY[\s\S]*?-- END ONBOARDING BOUNDARY/,
      "-- Onboarding boundary is exercised by the PGlite migration test.",
    )
    .replace(
      /-- BEGIN AUTH DELIVERY RLS[\s\S]*?-- END AUTH DELIVERY RLS/,
      "-- Auth delivery RLS is exercised by the PGlite migration test.",
    );
}

function productionTableNames(migration: string) {
  const names = [...migration.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/gi)]
    .map((match) => match[1]!);
  return [...new Set(names)].sort();
}

function tokenFromPreview(previewUrl: string) {
  const token = new URL(previewUrl).searchParams.get("token");
  assert.ok(token);
  return token;
}

async function loginAttempt(
  http: ReturnType<typeof request>,
  address: string,
  password = "ValidPassphrase123!",
  email = "unknown@example.com",
) {
  return http.post("/v1/auth/login").set("X-Forwarded-For", address).send({
    email,
    password,
  });
}

async function assertTenantBoundary(database: PGlite) {
  await database.exec(tenantSeedSql);
  await database.exec(`SET ROLE authenti8_backend;
    SELECT set_config('app.user_id', '${tenantUserA}', false);`);
  try {
    const visible = await database.query<{ id: string }>("SELECT id FROM organizations");
    assert.deepEqual(visible.rows.map((row) => row.id), [tenantOrganizationA]);
    await assert.rejects(database.exec(`INSERT INTO organization_members
      (organization_id, user_id, role, job_role)
      VALUES ('${tenantOrganizationB}', '${tenantUserA}', 'OWNER', 'Founder')`));
    await database.exec(
      `SELECT set_config('app.onboarding_organization_id', '${tenantOrganizationC}', false)`,
    );
    await database.exec(`INSERT INTO organizations(
      id, name, domain, company_size, expected_monthly_interviews, default_timezone
    ) VALUES ('${tenantOrganizationC}', 'Tenant C', 'c.example.com', '1-10', 1, 'UTC')`);
    await database.exec(`INSERT INTO organization_members
      (organization_id, user_id, role, job_role)
      VALUES ('${tenantOrganizationC}', '${tenantUserA}', 'OWNER', 'Founder')`);
    await database.exec(`INSERT INTO audit_logs
      (organization_id, actor_user_id, action, target_type)
      VALUES ('${tenantOrganizationA}', '${tenantUserA}', 'TEST', 'test')`);
    await assert.rejects(database.exec(`INSERT INTO audit_logs
      (organization_id, actor_user_id, action, target_type)
      VALUES ('${tenantOrganizationB}', '${tenantUserA}', 'TEST', 'test')`));
  } finally {
    await database.exec("RESET ROLE");
  }
}

const rlsTablesQuery = `
  SELECT table_name FROM information_schema.tables AS tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    AND EXISTS (
      SELECT 1 FROM pg_class AS classes
      JOIN pg_namespace AS namespaces ON namespaces.oid = classes.relnamespace
      WHERE namespaces.nspname = tables.table_schema
        AND classes.relname = tables.table_name AND classes.relrowsecurity
    )`;

const backendRoleQuery = `
  SELECT (NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolbypassrls) AS safe
  FROM pg_roles WHERE rolname = 'authenti8_backend'`;

const backendPrivilegesQuery = `
  SELECT (
    NOT has_table_privilege('authenti8_backend', 'schema_migrations', 'SELECT')
    AND has_table_privilege('authenti8_backend', 'auth_email_outbox', 'DELETE')
    AND NOT has_table_privilege('authenti8_backend', 'audit_logs', 'UPDATE')
    AND NOT has_table_privilege('authenti8_backend', 'audit_logs', 'DELETE')
    AND NOT has_table_privilege('authenti8_backend', 'credit_transactions', 'UPDATE')
    AND NOT has_table_privilege('authenti8_backend', 'telemetry_events', 'SELECT')
  ) AS safe`;

const tenantUserA = "00000000-0000-4000-8000-000000000001";
const tenantUserB = "00000000-0000-4000-8000-000000000002";
const tenantOrganizationA = "10000000-0000-4000-8000-000000000001";
const tenantOrganizationB = "10000000-0000-4000-8000-000000000002";
const tenantOrganizationC = "10000000-0000-4000-8000-000000000003";

const tenantSeedSql = `
  INSERT INTO users(id, email, normalized_email, full_name, email_verified_at)
  VALUES
    ('${tenantUserA}', 'a@example.com', 'a@example.com', 'Tenant A', now()),
    ('${tenantUserB}', 'b@example.com', 'b@example.com', 'Tenant B', now());
  INSERT INTO organizations(
    id, name, domain, company_size, expected_monthly_interviews, default_timezone
  ) VALUES
    ('${tenantOrganizationA}', 'Tenant A', 'a.example.com', '1-10', 1, 'UTC'),
    ('${tenantOrganizationB}', 'Tenant B', 'b.example.com', '1-10', 1, 'UTC');
  INSERT INTO organization_members(organization_id, user_id, role, job_role)
  VALUES
    ('${tenantOrganizationA}', '${tenantUserA}', 'OWNER', 'Founder'),
    ('${tenantOrganizationB}', '${tenantUserB}', 'OWNER', 'Founder');`;
