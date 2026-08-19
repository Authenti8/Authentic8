import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

const port = Number(process.env.E2E_API_PORT ?? 4100);
const webOrigin = process.env.E2E_WEB_ORIGIN ?? "http://127.0.0.1:3100";
const states = new Map();
const verifications = new Map();
const ids = {
  owner: "11111111-1111-4111-8111-111111111111",
  manager: "22222222-2222-4222-8222-222222222222",
  hr: "33333333-3333-4333-8333-333333333333",
};

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname === "/health") return json(response, 200, { ok: true });
  const identity = readIdentity(request.headers.cookie);
  const state = stateFor(identity.run);
  const body = await readBody(request);
  try {
    await route(request.method ?? "GET", url, body, identity, state,
      request.headers.authorization, response);
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : "Mock failure" });
  }
}).listen(port, "127.0.0.1");

async function route(method, url, body, identity, state, authorization, response) {
  if (routePublic(method, url, body, identity, state, response)) return;
  const tenant = tenantFor(state, identity.tenantKey);
  const reservation = /^\/v1\/internal\/workspace\/meetings\/([^/]+)\/reserve$/.exec(url.pathname);
  if (method === "POST" && reservation) {
    if (authorization !== "Bearer e2e-cron-secret") return json(response, 401, { message: "Unauthorized" });
    return reserveInterview(response, tenant, reservation[1]);
  }
  if (!identity.role) return json(response, 401, { error: "Unauthorized" });
  if (!tenant) return json(response, 404, { error: "Resource not found." });
  if (url.pathname === "/v1/overview") return json(response, 200, overview(tenant));
  if (url.pathname === "/v1/billing/capabilities") return json(response, 200,
    { role: identity.role, canPurchase: identity.role === "OWNER", canManagePortal: identity.role === "OWNER" });
  if (routeIntegrations(method, url, identity, tenant, response)) return;
  if (routeOrganization(method, url, body, identity, tenant, response)) return;
  if (url.pathname === "/v1/organizations" && method === "POST") {
    tenant.active = true; tenant.name = body.name; tenant.domain = body.domain;
    return json(response, 200, { organization: session(identity, state).organization, next: "/dashboard" });
  }
  return json(response, 404, { error: `Unmocked endpoint: ${method} ${url.pathname}` });
}

function routeIntegrations(method, url, identity, tenant, response) {
  if (url.pathname === "/v1/integrations" && method === "GET") return json(response, 200, integration(tenant, identity));
  if (url.pathname === "/v1/integrations/google/connect") {
    tenant.integrations[identity.userKey] = true;
    response.writeHead(302, { location: "/dashboard/integrations?connected=google" }); response.end(); return true;
  }
  if (url.pathname.endsWith("/integrations/google/disconnect")) {
    tenant.integrations[identity.userKey] = false; return json(response, 200, { disconnected: true });
  }
  if (url.pathname.endsWith("/integrations/google/sync")) return json(response, 200, { queued: true });
  return false;
}

function routeOrganization(method, url, body, identity, tenant, response) {
  if (url.pathname === "/v1/organization/members" && method === "GET") return json(response, 200, members(tenant, identity));
  if (url.pathname.endsWith("/organization/members/invite")) return inviteMember(response, identity, tenant, body);
  if (url.pathname === "/v1/organization/members/wallets" && method === "GET") return json(response, 200,
    { role: identity.role, wallets: [wallet(tenant)] });
  if (url.pathname === "/v1/organization/members/wallets" && method === "POST") return adjustWallet(response, identity, tenant, body);
  if (url.pathname === "/v1/organization/members/billing-grants" && method === "GET") return json(response, 200, []);
  if (url.pathname === "/v1/organization/members/billing-grants" && method === "POST") {
    if (identity.role !== "OWNER") return json(response, 403, { error: "Forbidden" });
    return json(response, 200, { updated: true });
  }
  return false;
}

function inviteMember(response, identity, tenant, body) {
  if (identity.role === "HR" || (identity.role === "MANAGER" && body.role === "MANAGER")) return json(response, 403, { error: "Forbidden" });
  tenant.invitations.push({ id: randomUUID(), email: body.email, role: body.role,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 259_200_000).toISOString() });
  return json(response, 200, { invited: true });
}

function adjustWallet(response, identity, tenant, body) {
  if (identity.role === "HR") return json(response, 403, { error: "Forbidden" });
  if (body.memberUserId !== tenantMemberId(tenant.key, "hr")) return json(response, 404, { error: "Resource not found." });
  const quantity = Number(body.quantity);
  if (body.operation === "GRANT" && quantity > tenant.organizationAvailable) return json(response, 409, { error: "Insufficient organization credits." });
  if (body.operation === "REDUCE" && quantity > tenant.hrAvailable) return json(response, 409, { error: "Cannot reduce reserved or unavailable credits." });
  tenant.hrAvailable += body.operation === "GRANT" ? quantity : -quantity;
  tenant.organizationAvailable += body.operation === "GRANT" ? -quantity : quantity;
  return json(response, 200, { adjusted: true });
}

function reserveInterview(response, tenant, meetingId) {
  const existing = tenant.reservations[meetingId];
  if (existing) return json(response, 201, { reserved: true, reservationId: existing.reservationId });
  if (tenant.organizationAvailable < 0) return json(response, 201, { reserved: false, reason: "NO_CREDITS" });
  if (tenant.hrAvailable < 1) return json(response, 201, { reserved: false, reason: "NO_HR_ALLOCATION" });
  tenant.hrAvailable -= 1; tenant.hrReserved += 1;
  const reservationId = deterministicId(`reservation:${meetingId}`);
  tenant.reservations[meetingId] = { reservationId };
  return json(response, 201, { reserved: true, reservationId });
}

function routePublic(method, url, body, identity, state, response) {
  if (url.pathname === "/v1/auth/login" && method === "POST") {
    if (body.password === "WrongPassword!1") return json(response, 401, { error: "Invalid email or password." });
    response.setHeader("set-cookie", "authenti8_session=OWNER:login:owner:tenant-a; Path=/; HttpOnly; SameSite=Lax");
    return json(response, 200, { message: "Welcome", next: "/dashboard" });
  }
  if (url.pathname === "/v1/auth/signup" && method === "POST") {
    if (String(body.email).endsWith("@gmail.com")) return json(response, 400, { error: "Use a work email address." });
    const token = `verify-${createHash("sha256").update(String(body.email)).digest("hex")}`;
    verifications.set(token, { email: body.email, password: body.password, used: false,
      expiresAt: String(body.email).startsWith("expired-") ? 0 : Date.now() + 86_400_000 });
    return json(response, 200, { message: "Verify your work email to continue.",
      previewUrl: `${webOrigin}/verify-email?token=${token}` });
  }
  if (url.pathname === "/v1/auth/verify-email" && method === "POST") {
    const verification = verifications.get(body.token);
    if (!verification || verification.used || verification.expiresAt <= Date.now()
      || verification.password !== body.password) {
      return json(response, 400, { error: "This verification link is invalid or expired." });
    }
    verification.used = true;
    response.setHeader("set-cookie",
      "authenti8_session=OWNER:verified:new-owner:new-company; Path=/; HttpOnly; SameSite=Lax");
    return json(response, 200, { message: "Email verified.", next: "/onboarding" });
  }
  if (url.pathname === "/v1/auth/session") {
    if (!identity.role) return json(response, 401, { error: "Unauthorized" });
    return json(response, 200, session(identity, state));
  }
  return false;
}

function stateFor(run) {
  if (!states.has(run)) states.set(run, { tenants: {
    "tenant-a": tenant("tenant-a", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Acme Hiring", "acme.test", true),
    "tenant-b": tenant("tenant-b", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Beta Hiring", "beta.test", true),
    "new-company": tenant("new-company", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "", "", false),
  } });
  return states.get(run);
}

function tenantFor(state, key) {
  if (!state.tenants[key] && /^tenant-\d+$/.test(key)) {
    state.tenants[key] = tenant(key, deterministicId(`organization:${key}`),
      `Scale Company ${key.slice(7)}`, `${key}.test`, true);
  }
  return state.tenants[key];
}

function tenant(key, id, name, domain, active) { return { key, id, name, domain, active,
  organizationAvailable: 10, organizationReserved: 0, hrAvailable: 0, hrReserved: 0,
  integrations: {}, invitations: [], reservations: {} }; }
function session(identity, state) {
  const current = state.tenants[identity.tenantKey]; const role = identity.role;
  const organization = current?.active ? { id: current.id, name: current.name, domain: current.domain, role } : null;
  return { user: { id: userId(identity), email: `${identity.userKey}@${current?.domain || "new.test"}`,
    fullName: `${role} User`, emailVerified: true }, organization };
}
function overview(current) { return { plan: "STARTER", status: "ACTIVE", allowance: 10,
  balance: current.organizationAvailable, used: 0, includedUsed: 0, periodStart: new Date().toISOString(),
  periodEnd: new Date(Date.now() + 2_592_000_000).toISOString(), cancelAtPeriodEnd: false,
  upcoming: current.organizationReserved, completed: 0, confirmed: 0, failed: 0, integrationActive: false,
  notificationCount: 0, recentReports: [] }; }
function integration(current, identity) { const active = current.integrations[identity.userKey]; return { provider: "GOOGLE_MEET",
  status: active ? "ACTIVE" : "NOT_CONNECTED", connectedEmail: active ? `${identity.userKey}@${current.domain}` : null,
  calendarName: active ? "Primary" : null, lastSyncedAt: active ? new Date().toISOString() : null, lastErrorCode: null }; }
function members(current, identity) { return { organizationId: current.id, role: identity.role,
  members: ["owner", "manager", ...Array.from({ length: 10 }, (_, index) => index ? `hr-${index}` : "hr")]
    .map((role) => ({ userId: tenantMemberId(current.key, role),
    name: `${role[0].toUpperCase()}${role.slice(1)} User`, email: `${role}@${current.domain}`,
    role: role.startsWith("hr") ? "HR" : role.toUpperCase(), status: "ACTIVE" })),
  invitations: current.invitations }; }
function wallet(current) { return { memberUserId: tenantMemberId(current.key, "hr"), name: "HR User",
  email: `hr@${current.domain}`, available: current.hrAvailable, reserved: current.hrReserved, consumed: 0 }; }
function tenantMemberId(tenantKey, roleKey) {
  if (tenantKey === "tenant-a" && ids[roleKey]) return ids[roleKey];
  return deterministicId(`${tenantKey}:${roleKey}`);
}
function userId(identity) {
  if (identity.userKey === identity.role.toLowerCase()) return tenantMemberId(identity.tenantKey, identity.userKey);
  return deterministicId(`${identity.tenantKey}:${identity.userKey}`);
}
function deterministicId(value) { const hash = createHash("sha256").update(`authenti8-e2e:${value}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`; }
function readIdentity(cookie = "") { const match = /(?:^|;\s*)authenti8_session=([^;]+)/.exec(cookie);
  if (!match) return { role: null, run: "anonymous", userKey: "anonymous", tenantKey: "tenant-a" };
  const parts = decodeURIComponent(match[1]).split(":");
  const [role, run = "default", userKey = role.toLowerCase()] = parts;
  const tenantKey = parts[3] ?? (userKey === "new-owner" ? "new-company" : "tenant-a");
  return { role: ["OWNER", "MANAGER", "HR"].includes(role) ? role : null, run, userKey, tenantKey }; }
async function readBody(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {}; try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; } }
function json(response, status, body) { response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body)); return true; }
