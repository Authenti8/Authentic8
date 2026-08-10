import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { SupabaseService } from "../supabase/supabase.service.js";
import { MailWorkerController } from "./mail-worker.controller.js";
import { MailService } from "./mail.service.js";

const environmentKeys = [
  "NODE_ENV", "VERCEL", "SUPABASE_URL", "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY", "APP_ORIGIN", "SMTP_HOST",
  "AUTH_MAIL_ENCRYPTION_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CALLBACK_URL", "GOOGLE_CALENDAR_CALLBACK_URL",
  "INTEGRATION_ENCRYPTION_KEY", "CRON_SECRET", "DODO_PAYMENTS_WEBHOOK_KEY",
] as const;

test("Vercel mail delivery only runs through the protected worker", async () => {
  const previous = snapshotEnvironment();
  configureVercelEnvironment();
  const calls: string[] = [];
  const supabase = {
    rpc: async (name: string) => { calls.push(name); return null; },
  } as unknown as SupabaseService;
  const mail = new MailService(supabase);
  const worker = new MailWorkerController(mail);
  try {
    mail.onApplicationBootstrap();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, []);
    await assert.rejects(worker.drain("Bearer wrong-secret"), /Unauthorized/);
    assert.deepEqual(await worker.drain("Bearer test-mail-worker-secret"), { processed: 0 });
    assert.equal(calls.filter((name) => name === "authenti8_claim_email").length, 10);
    assert.equal(calls.at(-1), "authenti8_cleanup_email");
  } finally {
    await mail.onModuleDestroy();
    restoreEnvironment(previous);
  }
});

test("candidate mail is prioritized and its lost claims recover within the delivery window", () => {
  const migration = readFileSync(resolve(process.cwd(),
    "../../infrastructure/postgres/025_interview_email_and_listing.sql"), "utf8");
  assert.match(migration,
    /ORDER BY CASE WHEN kind = 'candidate_verification' THEN 0 ELSE 1 END/);
  assert.equal((migration.match(/interval '30 seconds'/g) ?? []).length, 2);
  assert.doesNotMatch(migration, /lease_until = now\(\) \+ interval '5 minutes'/);
});

function configureVercelEnvironment() {
  process.env.NODE_ENV = "production";
  process.env.VERCEL = "1";
  process.env.SUPABASE_URL = "https://mail-test.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test-secret";
  process.env.APP_ORIGIN = "https://app.authenti8.example";
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.AUTH_MAIL_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");
  process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
  process.env.CRON_SECRET = "test-mail-worker-secret";
  process.env.GOOGLE_CLIENT_ID = "";
  process.env.GOOGLE_CLIENT_SECRET = "";
  process.env.GOOGLE_CALLBACK_URL = "";
  delete process.env.DODO_PAYMENTS_WEBHOOK_KEY;
}

function snapshotEnvironment() {
  return Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(previous: Record<string, string | undefined>) {
  for (const key of environmentKeys) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
