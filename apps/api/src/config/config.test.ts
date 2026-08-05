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

test("production refuses to run with the migration-owner database role", () => {
  withProductionEnvironment(() => {
    process.env.DATABASE_URL = "postgresql://postgres:secret@database.example.com/authenti8";
    assert.throws(() => loadConfig(), /authenti8_backend/);
  });
});

test("production refuses migration-owner secrets in the API process", () => {
  withProductionEnvironment(() => {
    process.env.DATABASE_MIGRATION_URL = "postgresql://owner:secret@database.example.com/db";
    assert.throws(() => loadConfig(), /must not be available/);
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
    "NODE_ENV", "SMTP_HOST", "DATABASE_URL", "APP_ORIGIN",
    "DATABASE_MIGRATION_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
    "GOOGLE_CALLBACK_URL", "AUTH_MAIL_ENCRYPTION_KEY",
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env.NODE_ENV = "production";
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.DATABASE_URL = backendDatabaseUrl;
  process.env.APP_ORIGIN = "https://app.authenti8.example";
  process.env.AUTH_MAIL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  delete process.env.DATABASE_MIGRATION_URL;
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

const backendDatabaseUrl =
  "postgresql://authenti8_backend:secret@database.example.com/authenti8";
