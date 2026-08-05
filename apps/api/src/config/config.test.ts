import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.js";

test("production refuses to start without SMTP delivery", () => {
  withProductionEnvironment(() => {
    delete process.env.SMTP_HOST;
    assert.throws(() => loadConfig(), /SMTP_HOST/);
  });
});

test("production requires an email outbox encryption key", () => {
  withProductionEnvironment(() => {
    delete process.env.AUTH_MAIL_ENCRYPTION_KEY;
    assert.throws(() => loadConfig(), /AUTH_MAIL_ENCRYPTION_KEY/);
  });
});

test("production requires a Supabase secret key", () => {
  withProductionEnvironment(() => {
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    assert.throws(() => loadConfig(), /SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY/);
  });
});

test("Supabase URL must be valid", () => {
  withProductionEnvironment(() => {
    process.env.SUPABASE_URL = "not-a-url";
    assert.throws(() => loadConfig(), /SUPABASE_URL must use HTTPS/);
  });
});

test("production rejects an insecure Supabase URL", () => {
  withProductionEnvironment(() => {
    process.env.SUPABASE_URL = "http://project.supabase.co";
    assert.throws(() => loadConfig(), /SUPABASE_URL must use HTTPS/);
  });
});

test("development permits a loopback Supabase URL", () => {
  withProductionEnvironment(() => {
    process.env.NODE_ENV = "development";
    process.env.SUPABASE_URL = "http://127.0.0.1:54321";
    assert.equal(loadConfig().supabaseUrl, "http://127.0.0.1:54321");
  });
});

test("development permits an IPv6 loopback Supabase URL", () => {
  withProductionEnvironment(() => {
    process.env.NODE_ENV = "development";
    process.env.SUPABASE_URL = "http://[::1]:54321";
    assert.equal(loadConfig().supabaseUrl, "http://[::1]:54321");
  });
});

test("production requires an explicit public application origin", () => {
  withProductionEnvironment(() => {
    delete process.env.APP_ORIGIN;
    assert.throws(() => loadConfig(), /APP_ORIGIN/);
  });
});

test("production rejects localhost as the application origin", () => {
  withProductionEnvironment(() => {
    process.env.APP_ORIGIN = "http://localhost:3000";
    assert.throws(() => loadConfig(), /public HTTPS URL/);
  });
});

test("configured Google login requires an explicit production callback", () => {
  withProductionEnvironment(() => {
    process.env.GOOGLE_CLIENT_ID = "client";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    delete process.env.GOOGLE_CALLBACK_URL;
    assert.throws(() => loadConfig(), /GOOGLE_CALLBACK_URL/);
  });
});

function withProductionEnvironment(run: () => void) {
  const names = [
    "NODE_ENV", "SMTP_HOST", "SUPABASE_URL", "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY", "APP_ORIGIN",
    "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
    "GOOGLE_CALLBACK_URL", "AUTH_MAIL_ENCRYPTION_KEY",
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env.NODE_ENV = "production";
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test-secret-key";
  process.env.APP_ORIGIN = "https://app.authenti8.example";
  process.env.AUTH_MAIL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CALLBACK_URL;
  try {
    run();
  } finally {
    for (const [name, value] of previous) restoreEnvironment(name, value);
  }
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
