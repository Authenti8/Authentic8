import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { request, test, expect, type APIRequestContext } from "@playwright/test";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

type ReportingFixture = {
  database: PGlite;
  userId: string;
  organizationId: string;
  ownerCookie: string;
};
type ScaleRepresentative = { hrCookie: string; ownerCookie: string;
  organizationId: string; hrId: string };

const cronSecret = "playwright-ledger-cron-secret";
let fixture: ReportingFixture;
let application: INestApplication;
let api: APIRequestContext;
const nativeFetch = globalThis.fetch;

test.beforeAll(async () => {
  configureEnvironment();
  fixture = await createFixture();
  const [{ AppModule }, { configureApplication }, { SupabaseService }] = await Promise.all([
    import("../../apps/api/dist/app.module.js"), import("../../apps/api/dist/application.js"),
    import("../../apps/api/dist/supabase/supabase.service.js"),
  ]);
  const databaseAdapter = { rpc: <T>(name: string, input: Record<string, unknown> = {}) =>
    rpc<T>(fixture.database, name, input) };
  const testingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SupabaseService).useValue(databaseAdapter).compile();
  const app = testingModule.createNestApplication<NestExpressApplication>();
  configureApplication(app, (await import("../../apps/api/dist/config.js")).loadConfig(),
    { shutdownHooks: false });
  await app.listen(0, "127.0.0.1");
  application = app;
  const address = app.getHttpServer().address();
  if (!address || typeof address === "string") throw new Error("Real API did not bind a test port");
  api = await request.newContext({ baseURL: `http://127.0.0.1:${address.port}` });
  globalThis.fetch = controlledGoogleFetch;
  await bootstrapOwner();
});

test.afterAll(async () => {
  await api?.dispose();
  await application?.close();
  await fixture?.database.close();
  globalThis.fetch = nativeFetch;
});

test("real API rejects mismatched, expired, and reused verification tokens", async () => {
  const password = "PlaywrightPassphrase123!";
  const token = await signupToken("real-token-owner@example.com", password);
  expect((await api.post("/v1/auth/verify-email", { data: {
    token, password: "DifferentPassphrase123!",
  } })).status()).toBe(400);
  expect((await api.post("/v1/auth/verify-email", { data: { token, password } })).status()).toBe(201);
  expect((await api.post("/v1/auth/verify-email", { data: { token, password } })).status()).toBe(400);
  const expired = await signupToken("real-expired-owner@example.com", password);
  await fixture.database.query(`UPDATE email_verification_tokens SET expires_at=now()-interval '1 minute'
    WHERE token_hash=$1`, [tokenHash(expired)]);
  expect((await api.post("/v1/auth/verify-email", { data: {
    token: expired, password,
  } })).status()).toBe(400);
});

test("real API keeps 100 organizations and 1,000 HR sessions isolated", async () => {
  test.setTimeout(180_000);
  const representatives = await provisionScaleTenants();
  const counts = await fixture.database.query<{ organizations: number; hrs: number; sessions: number }>(`
    SELECT (SELECT count(*)::INTEGER FROM organizations WHERE domain LIKE 'scale-%.test') organizations,
      (SELECT count(*)::INTEGER FROM organization_members WHERE business_role='HR'
        AND organization_id IN (SELECT id FROM organizations WHERE domain LIKE 'scale-%.test')) hrs,
      (SELECT count(*)::INTEGER FROM sessions WHERE user_id IN (SELECT user_id
        FROM organization_members WHERE business_role='HR' AND organization_id IN
          (SELECT id FROM organizations WHERE domain LIKE 'scale-%.test'))) sessions`);
  expect(counts.rows[0]).toEqual({ organizations: 100, hrs: 1000, sessions: 1000 });
  for (const representative of representatives) {
    const hrResponse = await api.get("/v1/organization/members", {
      headers: { cookie: representative.hrCookie },
    });
    expect(hrResponse.status()).toBe(200);
    const hrBody = await hrResponse.json() as { organizationId: string;
      members: Array<{ userId: string }> };
    expect(hrBody).toEqual(expect.objectContaining({ organizationId: representative.organizationId,
      members: [expect.objectContaining({ userId: representative.hrId })] }));
    const ownerResponse = await api.get("/v1/organization/members", {
      headers: { cookie: representative.ownerCookie },
    });
    expect(ownerResponse.status()).toBe(200);
    const ownerBody = await ownerResponse.json() as { organizationId: string; members: unknown[] };
    expect(ownerBody.organizationId).toBe(representative.organizationId);
    expect(ownerBody.members).toHaveLength(11);
  }
  const local = representatives[0]!; const foreign = representatives[1]!;
  const attempt = (memberUserId: string) => api.post("/v1/organization/members/wallets", {
    headers: { cookie: local.ownerCookie }, data: { memberUserId, operation: "GRANT", quantity: 1,
      reason: "Cross tenant isolation verification", idempotencyKey: randomUUID() },
  });
  const foreignResponse = await attempt(foreign.hrId);
  const missingResponse = await attempt("99999999-9999-4999-8999-999999999999");
  expect(foreignResponse.status()).toBe(missingResponse.status());
  expect(await foreignResponse.json()).toEqual(await missingResponse.json());
});

async function provisionScaleTenants() {
  const organizations = new Set<string>(); const representatives: ScaleRepresentative[] = [];
  for (let organization = 0; organization < 100; organization += 1) {
    const owner = await createVerifiedUser(`scale-owner-${organization}@ledger.test`, "Scale Owner");
    const created = await rpc<{ organization: { id: string } }>(fixture.database,
      "authenti8_create_organization", { userId: owner, name: `Scale Company ${organization}`,
        domain: `scale-${organization}.test`, jobRole: "Founder", timezone: "UTC",
        companySize: "1-10", expectedMonthlyInterviews: 10 });
    organizations.add(created.organization.id);
    const ownerCookie = await createSessionCookie(owner, `scale-owner-${organization}`);
    for (let interviewer = 0; interviewer < 10; interviewer += 1) {
      const hr = await createVerifiedUser(
        `scale-${organization}-hr-${interviewer}@ledger.test`, "Scale HR");
      await addOrganizationMembership(created.organization.id, hr, "HR");
      const hrCookie = await createSessionCookie(hr, `scale-${organization}-${interviewer}`);
      if (interviewer === 0) representatives.push({ hrCookie, ownerCookie,
        organizationId: created.organization.id, hrId: hr });
    }
  }
  expect(organizations.size).toBe(100);
  return representatives;
}

test("real database isolates ten HR calendars plus Owner and Manager", async () => {
  const manager = await createOrganizationMember("MANAGER", "calendar-manager");
  const interviewers = [fixture.userId, manager];
  for (let index = 0; index < 10; index += 1) {
    interviewers.push(await createOrganizationMember("HR", `calendar-hr-${index}`));
  }
  const cookies = [fixture.ownerCookie];
  for (const [index, userId] of interviewers.entries()) {
    if (index) cookies.push(await createSessionCookie(userId, `calendar-${index}`));
    await connectGoogle(cookies[index]!, index);
  }
  const connected = await fixture.database.query<{ integrations: number; members: number }>(`
    SELECT count(*)::INTEGER integrations,
      count(DISTINCT connected_user_id)::INTEGER members FROM google_integrations
    WHERE organization_id=$1 AND status='ACTIVE'`, [fixture.organizationId]);
  expect(connected.rows[0]).toEqual({ integrations: 12, members: 12 });
  for (const [index, userId] of interviewers.entries()) {
    const summary = await rpc<{ connectedEmail: string; status: string }>(fixture.database,
      "authenti8_integration_summary", { userId });
    expect(summary).toMatchObject({ status: "ACTIVE",
      connectedEmail: `calendar-${index}@company.test` });
  }
  const disconnected = await api.post("/v1/integrations/google/disconnect", {
    headers: { cookie: cookies[2]! }, data: {},
  });
  expect(disconnected.status()).toBe(201);
  expect(await disconnected.json()).toEqual({ disconnected: true });
  const remaining = await fixture.database.query<{ active: number }>(`
    SELECT count(*)::INTEGER active FROM google_integrations
    WHERE organization_id=$1 AND status='ACTIVE'`, [fixture.organizationId]);
  expect(remaining.rows[0]?.active).toBe(11);
  expect(await rpc(fixture.database, "authenti8_integration_summary", {
    userId: interviewers[3],
  })).toMatchObject({ status: "ACTIVE", connectedEmail: "calendar-3@company.test" });
  await fixture.database.query(`UPDATE organization_members SET status='SUSPENDED'
    WHERE organization_id=$1 AND user_id=$2`, [fixture.organizationId, interviewers[3]]);
  const suspended = await fixture.database.query<{ status: string; token: string | null }>(`
    SELECT status,encrypted_access_token token FROM google_integrations
    WHERE organization_id=$1 AND connected_user_id=$2`, [fixture.organizationId, interviewers[3]]);
  expect(suspended.rows[0]).toEqual({ status: "NOT_CONNECTED", token: null });
});

test("real API and ledger enforce five HR reservations", async () => {
  const hr = await createHrMember();
  const walletEndpoint = "/v1/organization/members/wallets";
  const allocationInput = { memberUserId: hr, operation: "GRANT", quantity: 5,
    reason: "Allocate five protected interviews", idempotencyKey: randomUUID() };
  expect((await api.post(walletEndpoint, {
    headers: { cookie: "" }, data: allocationInput,
  })).status()).toBe(401);
  const allocation = await api.post(walletEndpoint, {
    headers: { cookie: fixture.ownerCookie }, data: allocationInput,
  });
  expect(allocation.status()).toBe(201);
  expect(await allocation.json()).toEqual({ updated: true, available: 5 });
  const meetings = await createEligibleInterviews(hr, 6);
  const endpoint = (id: string) => `/v1/internal/workspace/meetings/${id}/reserve`;

  expect((await api.post(endpoint(meetings[0]!))).status()).toBe(401);
  const results: Array<{ reserved: boolean; reservationId?: string; reason?: string }> = [];
  for (const meeting of meetings) {
    const response = await api.post(endpoint(meeting), {
      headers: { authorization: `Bearer ${cronSecret}` },
    });
    expect(response.status()).toBe(201);
    results.push(await response.json());
  }
  expect(results.slice(0, 5).every((result) => result.reserved)).toBe(true);
  expect(results[5]).toEqual({ reserved: false, reason: "NO_HR_ALLOCATION" });
  const retry = await api.post(endpoint(meetings[0]!), {
    headers: { authorization: `Bearer ${cronSecret}` },
  });
  expect(await retry.json()).toEqual(results[0]);

  const ledger = await fixture.database.query<{ reserved: number; amount: number; allocations: number }>(`
    SELECT count(*) FILTER (WHERE kind='INTERVIEW_RESERVED')::INTEGER reserved,
      COALESCE(sum(amount) FILTER (WHERE kind='INTERVIEW_RESERVED'),0)::INTEGER amount,
      count(*) FILTER (WHERE kind='ALLOCATION_GRANTED')::INTEGER allocations
    FROM hr_wallet_transactions WHERE member_user_id=$1`, [hr]);
  expect(ledger.rows[0]).toEqual({ reserved: 5, amount: -5, allocations: 1 });
  const reservations = await fixture.database.query<{ count: number }>(`
    SELECT count(*)::INTEGER count FROM credit_reservations
    WHERE member_user_id=$1 AND status='RESERVED'`, [hr]);
  expect(reservations.rows[0]?.count).toBe(5);
});

async function createFixture() {
  const database = new PGlite({ extensions: { pgcrypto } });
  await database.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY)");
  const directory = resolve(process.cwd(), "infrastructure/postgres");
  const migrations = readdirSync(directory).filter((file) => /^\d+.*\.sql$/.test(file)).sort()
    .map((file) => readFileSync(resolve(directory, file), "utf8")).join("\n");
  await database.exec(migrations);
  return { database, userId: "", organizationId: "", ownerCookie: "" };
}

async function bootstrapOwner() {
  const credentials = { fullName: "Playwright Owner", email: "playwright-owner@example.com",
    password: "PlaywrightPassphrase123!" };
  const token = await signupToken(credentials.email, credentials.password, credentials.fullName);
  const verification = await api.post("/v1/auth/verify-email", {
    data: { token, password: credentials.password },
  });
  expect(verification.status()).toBe(201);
  const setCookie = verification.headers()["set-cookie"];
  if (!setCookie) throw new Error("Verification did not establish an owner session");
  fixture.ownerCookie = setCookie.split(";", 1)[0]!;
  const session = await api.get("/v1/auth/session", {
    headers: { cookie: fixture.ownerCookie },
  });
  expect(session.status()).toBe(200);
  fixture.userId = (await session.json() as { user: { id: string } }).user.id;
  const organization = await api.post("/v1/organizations", {
    headers: { cookie: fixture.ownerCookie },
    data: { name: "Playwright Ledger", domain: "playwright-ledger.example.com",
      jobRole: "Founder", companySize: "1-10", expectedMonthlyInterviews: 10,
      timezone: "UTC" },
  });
  expect(organization.status()).toBe(201);
  fixture.organizationId = (await organization.json() as {
    organization: { id: string };
  }).organization.id;
}

async function signupToken(email: string, password: string, fullName = "Playwright Token Owner") {
  const signup = await api.post("/v1/auth/signup", { data: { fullName, email, password } });
  expect(signup.status()).toBe(201);
  const previewUrl = (await signup.json() as { previewUrl?: string }).previewUrl;
  if (!previewUrl) throw new Error("Local verification preview URL was not returned");
  const token = new URL(previewUrl).searchParams.get("token");
  if (!token) throw new Error("Verification preview URL did not include a token");
  return token;
}

async function connectGoogle(sessionCookie: string, index: number) {
  const connect = await api.get("/v1/integrations/google/connect", {
    headers: { cookie: sessionCookie }, maxRedirects: 0,
  });
  expect(connect.status()).toBe(302);
  const authorization = new URL(connect.headers().location!);
  const state = authorization.searchParams.get("state");
  if (!state) throw new Error("Google authorization redirect omitted state");
  const stateCookie = cookieFromHeader(connect.headers()["set-cookie"],
    "authenti8_integration_state");
  const callback = await api.get(`/v1/integrations/google/callback?code=calendar-${index}&state=${state}`, {
    headers: { cookie: `${sessionCookie}; ${stateCookie}` }, maxRedirects: 0,
  });
  expect(callback.status()).toBe(302);
  expect(callback.headers().location).toContain("connected=google");
}

function cookieFromHeader(header: string | undefined, name: string) {
  const match = header?.split(/,(?=[^;,]+=)/).find((value) => value.trim().startsWith(`${name}=`));
  if (!match) throw new Error(`${name} cookie was not returned`);
  return match.trim().split(";", 1)[0]!;
}

async function createHrMember() {
  return createOrganizationMember("HR", "ledger-hr");
}

async function createOrganizationMember(role: "MANAGER" | "HR", key: string) {
  const userId = await createVerifiedUser(`${key}@ledger.test`, `Playwright ${role}`);
  await addOrganizationMembership(fixture.organizationId, userId, role);
  return userId;
}

async function createVerifiedUser(email: string, fullName: string) {
  const user = await rpc<{ id: string }>(fixture.database, "authenti8_create_user", {
    email, fullName,
  });
  await fixture.database.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [user.id]);
  return user.id;
}

async function addOrganizationMembership(organizationId: string, userId: string,
  role: "MANAGER" | "HR") {
  await fixture.database.query(`INSERT INTO organization_members(organization_id,user_id,role,
    job_role,business_role,status) VALUES($1,$2,$3,$4,$4,'ACTIVE')`,
  [organizationId, userId, role === "MANAGER" ? "ADMIN" : "RECRUITER", role]);
}

async function createSessionCookie(userId: string, key: string) {
  const rawToken = `playwright-session-${key}-${randomUUID()}`;
  await rpc(fixture.database, "authenti8_create_session", { userId,
    tokenHash: tokenHash(rawToken), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    userAgentHash: "playwright", ipHash: "playwright" });
  return `authenti8_session=${rawToken}`;
}

async function createEligibleInterviews(hr: string, count: number) {
  const meetings: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID(); const start = new Date(Date.now() + (index + 1) * 60_000);
    await fixture.database.query(`INSERT INTO interviews(id,organization_id,google_event_id,
      google_calendar_id,google_meet_code,google_meet_url,candidate_email,candidate_name,
      organizer_email,title,scheduled_start,scheduled_end,status,protection_status)
      VALUES($1,$2,$3,'primary',$4,$5,$6,$7,'playwright-owner@ledger.test','Ledger interview',
        $8,$9,'EXCLUDED','RELEASED')`, [id, fixture.organizationId, `event-${id}`,
      id.slice(0, 11), `https://meet.google.com/${id.slice(0, 11)}`,
      `ledger-${index}@candidate.test`, `Ledger Candidate ${index}`, start,
      new Date(start.getTime() + 30 * 60_000)]);
    await fixture.database.query("UPDATE interviews SET responsible_member_user_id=$1 WHERE id=$2",
      [hr, id]);
    meetings.push(id);
  }
  await fixture.database.exec("ALTER TABLE interviews DISABLE TRIGGER authenti8_interview_credit_update");
  try {
    await fixture.database.query("UPDATE interviews SET status='DETECTED' WHERE id=ANY($1)", [meetings]);
  } finally {
    await fixture.database.exec("ALTER TABLE interviews ENABLE TRIGGER authenti8_interview_credit_update");
  }
  return meetings;
}

function configureEnvironment() {
  process.env.NODE_ENV = "development";
  for (const name of ["APP_ORIGIN", "AUTH_ORIGIN", "ONBOARDING_ORIGIN", "DASHBOARD_ORIGIN",
    "PAYMENT_ORIGIN"] as const) process.env[name] = "http://127.0.0.1:3100";
  process.env.SESSION_COOKIE_DOMAIN = "";
  process.env.API_ORIGIN = "http://127.0.0.1:4000";
  process.env.SUPABASE_URL = "https://playwright.supabase.invalid";
  process.env.SUPABASE_SECRET_KEY = "playwright-secret-key";
  process.env.SUPABASE_PUBLISHABLE_KEY = "playwright-publishable-key";
  process.env.GOOGLE_CLIENT_ID = "playwright-google-client";
  process.env.GOOGLE_CLIENT_SECRET = "playwright-google-secret";
  process.env.SMTP_HOST = "";
  process.env.SMTP_USER = "";
  process.env.SMTP_PASSWORD = "";
  process.env.CRON_SECRET = cronSecret;
  process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
}

async function rpc<T>(database: PGlite, name: string,
  input: Record<string, unknown> = {}) {
  if (!/^authenti8_[a-z_]+$/.test(name)) throw new Error("Invalid test RPC name");
  const result = await database.query<{ result: T }>(`SELECT ${name}($1::jsonb) result`,
    [JSON.stringify(input)]);
  return result.rows[0]!.result;
}

function tokenHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function controlledGoogleFetch(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname === "oauth2.googleapis.com") {
    const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    const code = body.get("code") ?? "refresh";
    return googleJson({ access_token: `access-${code}`, refresh_token: `refresh-${code}`,
      expires_in: 3600, token_type: "Bearer" });
  }
  const authorization = new Headers(init?.headers).get("authorization") ?? "";
  const key = authorization.replace("Bearer access-calendar-", "");
  if (url.hostname === "openidconnect.googleapis.com") {
    return googleJson({ sub: `subject-${key}`, email: `calendar-${key}@company.test`,
      email_verified: true });
  }
  if (url.pathname.endsWith("/users/me/calendarList/primary")) {
    return googleJson({ id: `calendar-${key}`, summary: "Primary" });
  }
  if (url.pathname.endsWith("/events/watch")) {
    return googleJson({ resourceId: `resource-${key}`,
      expiration: String(Date.now() + 86_400_000) });
  }
  if (url.pathname.endsWith("/channels/stop")) return new Response(null, { status: 204 });
  throw new Error(`Unexpected controlled Google request: ${url}`);
}

function googleJson(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200,
    headers: { "content-type": "application/json" } });
}
