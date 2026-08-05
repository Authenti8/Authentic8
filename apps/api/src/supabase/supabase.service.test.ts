import assert from "node:assert/strict";
import { test } from "node:test";
import { SupabaseService } from "./supabase.service.js";

test("Supabase RPC authenticates modern and legacy server keys correctly", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalSecret = process.env.SUPABASE_SECRET_KEY;
  const originalLegacy = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let headers: Record<string, string> = {};
  globalThis.fetch = async (_input, init) => {
    headers = init?.headers as Record<string, string>;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    process.env.SUPABASE_URL = "https://project.supabase.co";
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
  }
});

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
