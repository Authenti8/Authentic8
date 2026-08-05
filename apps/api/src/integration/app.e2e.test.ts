import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import request from "supertest";
import { AppModule } from "../app.module.js";
import { configureApplication } from "../application.js";
import { loadConfig } from "../config.js";
import { SupabaseService } from "../supabase/supabase.service.js";

process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.SUPABASE_URL ??= "https://integration.supabase.invalid";
process.env.SUPABASE_SECRET_KEY ??= "test-secret-key";
process.env.SMTP_HOST = "";
process.env.SMTP_USER = "";
process.env.SMTP_PASSWORD = "";

type Harness = { app: INestApplication; database: TestSupabase };
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

test("signup recovers when another request creates the user first", async () => {
  const { app, database } = await createHarness();
  database.simulateConcurrentUserCreationOnce();
  const signup = await request(app.getHttpServer()).post("/v1/auth/signup").send(validSignup());
  assert.equal(signup.status, 201);
  assert.ok(tokenFromPreview(signup.body.previewUrl));
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

test("the production migration enables RLS and restricts Data API functions", async () => {
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
    await assertRpcPermissions(database);
    await assertLegacyRoleCannotRead(database);
    await assertRateLimitCleanupIsBounded(database);
  } finally {
    await database.close();
  }
});

test("the Supabase migration disables an existing runtime login role", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    const migrations = loadProductionMigrationFiles();
    await database.exec(migrations.slice(0, 2).join("\n"));
    await database.exec("ALTER ROLE authenti8_backend LOGIN");
    await database.exec(migrations.slice(2).join("\n"));
    const role = await database.query<{ rolcanlogin: boolean }>(
      "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'authenti8_backend'",
    );
    assert.equal(role.rows[0]?.rolcanlogin, false);
  } finally {
    await database.close();
  }
});

async function createHarness() {
  const database = await TestSupabase.create();
  const testingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SupabaseService).useValue(database).compile();
  const app = testingModule.createNestApplication<NestExpressApplication>();
  configureApplication(app, loadConfig());
  await app.listen(0, "127.0.0.1");
  const harness = { app, database };
  activeHarnesses.push(harness);
  return harness;
}

class TestSupabase {
  private concurrentUserCreation = false;

  private constructor(private readonly database: PGlite) {}

  static async create() {
    const database = new PGlite({ extensions: { pgcrypto } });
    await database.exec(loadProductionMigrations());
    return new TestSupabase(database);
  }

  async rpc<T>(name: string, input: Record<string, unknown> = {}) {
    if (!/^authenti8_[a-z_]+$/.test(name)) throw new Error("Invalid test RPC name");
    if (name === "authenti8_create_user" && this.concurrentUserCreation) {
      this.concurrentUserCreation = false;
      await this.callRpc(name, input);
      return null as T;
    }
    return this.callRpc<T>(name, input);
  }

  simulateConcurrentUserCreationOnce() {
    this.concurrentUserCreation = true;
  }

  private async callRpc<T>(name: string, input: Record<string, unknown>) {
    const result = await this.database.query<{ value: T }>(
      `SELECT ${name}($1::jsonb) AS value`,
      [JSON.stringify(input)],
    );
    return result.rows[0]?.value as T;
  }

  query<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
    return this.database.query<T>(text, values);
  }

  exec(sql: string) {
    return this.database.exec(sql);
  }

  async close() {
    await this.database.close();
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

async function assertRpcPermissions(database: PGlite) {
  for (const role of ["anon", "authenticated"]) {
    await database.exec(`SET ROLE ${role}`);
    try {
      await assert.rejects(database.query("SELECT authenti8_health('{}'::jsonb)"));
      await assert.rejects(
        database.query("SELECT authenti8_has_organization_access(NULL::UUID)"),
      );
      await assert.rejects(
        database.query("SELECT authenti8_create_organization('{}'::jsonb)"),
      );
    } finally {
      await database.exec("RESET ROLE");
    }
  }
  await database.exec("SET ROLE service_role");
  try {
    const health = await database.query<{ value: { ok: boolean } }>(
      "SELECT authenti8_health('{}'::jsonb) AS value",
    );
    assert.equal(health.rows[0]?.value.ok, true);
  } finally {
    await database.exec("RESET ROLE");
  }
}

async function assertLegacyRoleCannotRead(database: PGlite) {
  await database.exec("SET ROLE authenti8_backend");
  try {
    await assert.rejects(database.query("SELECT id FROM users"));
  } finally {
    await database.exec("RESET ROLE");
  }
}

async function assertRateLimitCleanupIsBounded(database: PGlite) {
  await database.exec(`INSERT INTO auth_rate_limits(
    key_hash, request_count, window_started_at, expires_at
  ) SELECT 'expired-' || value, 1, now() - interval '2 hours', now() - interval '1 hour'
    FROM generate_series(1, 150) AS value`);
  const cleanup = await database.query<{ removed: number }>(
    "SELECT authenti8_cleanup_rate_limits('{}'::jsonb) AS removed",
  );
  assert.equal(cleanup.rows[0]?.removed, 100);
  const remaining = await database.query<{ count: number }>(
    "SELECT count(*)::INTEGER AS count FROM auth_rate_limits WHERE expires_at <= now()",
  );
  assert.equal(remaining.rows[0]?.count, 50);
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
    AND NOT rolbypassrls AND NOT rolcanlogin) AS safe
  FROM pg_roles WHERE rolname = 'authenti8_backend'`;

const backendPrivilegesQuery = `
  SELECT (
    NOT has_table_privilege('authenti8_backend', 'schema_migrations', 'SELECT')
    AND NOT has_table_privilege('authenti8_backend', 'users', 'SELECT')
    AND NOT has_table_privilege('authenti8_backend', 'auth_email_outbox', 'DELETE')
    AND NOT has_table_privilege('authenti8_backend', 'audit_logs', 'UPDATE')
    AND NOT has_table_privilege('authenti8_backend', 'audit_logs', 'DELETE')
    AND NOT has_table_privilege('authenti8_backend', 'credit_transactions', 'UPDATE')
    AND NOT has_table_privilege('authenti8_backend', 'telemetry_events', 'SELECT')
  ) AS safe`;
