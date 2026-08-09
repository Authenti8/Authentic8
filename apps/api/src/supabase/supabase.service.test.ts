import assert from "node:assert/strict";
import { test } from "node:test";
import { SupabaseService } from "./supabase.service.js";

test("Supabase RPC authenticates modern and legacy server keys correctly", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalSecret = process.env.SUPABASE_SECRET_KEY;
  const originalLegacy = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalIntegrationKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  let headers: Record<string, string> = {};
  globalThis.fetch = async (_input, init) => {
    headers = init?.headers as Record<string, string>;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    process.env.SUPABASE_URL = "https://project.supabase.co";
    process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
    process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await new SupabaseService().rpc("authenti8_health");
    assert.equal(headers.apikey, "sb_secret_test");
    assert.equal(headers.authorization, undefined);

    delete process.env.SUPABASE_SECRET_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "legacy.jwt.key";
    await new SupabaseService().rpc("authenti8_health");
    assert.equal(headers.apikey, "legacy.jwt.key");
    assert.equal(headers.authorization, "Bearer legacy.jwt.key");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("SUPABASE_URL", originalUrl);
    restoreEnvironment("SUPABASE_SECRET_KEY", originalSecret);
    restoreEnvironment("SUPABASE_SERVICE_ROLE_KEY", originalLegacy);
    restoreEnvironment("INTEGRATION_ENCRYPTION_KEY", originalIntegrationKey);
  }
});

test("Google identity exchange uses only the public Supabase key", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalPublishable = process.env.SUPABASE_PUBLISHABLE_KEY;
  const originalIntegrationKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (String(input).includes("/logout")) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({
      access_token: "temporary-supabase-access-token",
      user: { id: "3fd7b244-d751-42bb-8bdc-a2cfdf818ee4", email: "Person@Example.com" },
    }), { status: 200 });
  };
  try {
    process.env.SUPABASE_URL = "https://project.supabase.co";
    process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
    process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
    const identity = await new SupabaseService().signInWithGoogleIdToken(
      "google-id-token", "google-access-token",
    );
    assert.equal(requests[0]?.url, "https://project.supabase.co/auth/v1/token?grant_type=id_token");
    assert.equal(headerValue(requests[0]?.init, "apikey"), "sb_publishable_test");
    assert.equal(headerValue(requests[0]?.init, "authorization"), undefined);
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      provider: "google", id_token: "google-id-token", access_token: "google-access-token",
    });
    assert.equal(requests[1]?.url, "https://project.supabase.co/auth/v1/logout?scope=local");
    assert.equal(headerValue(requests[1]?.init, "apikey"), "sb_publishable_test");
    assert.equal(
      headerValue(requests[1]?.init, "authorization"),
      "Bearer temporary-supabase-access-token",
    );
    assert.deepEqual(identity, {
      id: "3fd7b244-d751-42bb-8bdc-a2cfdf818ee4", email: "person@example.com",
    });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("SUPABASE_URL", originalUrl);
    restoreEnvironment("SUPABASE_PUBLISHABLE_KEY", originalPublishable);
    restoreEnvironment("INTEGRATION_ENCRYPTION_KEY", originalIntegrationKey);
  }
});

function headerValue(init: RequestInit | undefined, name: string) {
  return new Headers(init?.headers).get(name) ?? undefined;
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
