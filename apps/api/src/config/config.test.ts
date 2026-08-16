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

test("production requires a strong mail worker secret", () => {
  withProductionEnvironment(() => {
    delete process.env.CRON_SECRET;
    assert.throws(() => loadConfig(), /CRON_SECRET/);
  });
});

test("production requires a dedicated accuracy upload secret", () => {
  withProductionEnvironment(() => {
    delete process.env.ACCURACY_UPLOAD_SECRET;
    assert.throws(() => loadConfig(), /ACCURACY_UPLOAD_SECRET/);
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

test("configured Google login defaults to the authentication origin", () => {
  withProductionEnvironment(() => {
    process.env.GOOGLE_CLIENT_ID = "client";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.SUPABASE_PUBLISHABLE_KEY = "publishable";
    process.env.AUTH_ORIGIN = "https://auth.authenti8.example";
    process.env.SESSION_COOKIE_DOMAIN = ".authenti8.example";
    delete process.env.GOOGLE_CALLBACK_URL;
    assert.equal(
      loadConfig().googleCallbackUrl,
      "https://auth.authenti8.example/api/v1/auth/google/callback",
    );
  });
});

test("production permits exact configured feature origins with a shared cookie", () => {
  withProductionEnvironment(() => {
    process.env.AUTH_ORIGIN = "https://auth.authenti8.example";
    process.env.DASHBOARD_ORIGIN = "https://dashboard.authenti8.example";
    process.env.SESSION_COOKIE_DOMAIN = ".authenti8.example";
    const config = loadConfig();
    assert.deepEqual(config.allowedOrigins, [
      "https://app.authenti8.example",
      "https://auth.authenti8.example",
      "https://dashboard.authenti8.example",
    ]);
    assert.equal(config.cookieDomain, ".authenti8.example");
  });
});

test("configured Google login requires a public Supabase key", () => {
  withProductionEnvironment(() => {
    process.env.GOOGLE_CLIENT_ID = "client";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_CALLBACK_URL = "https://app.authenti8.example/api/v1/auth/google/callback";
    delete process.env.SUPABASE_PUBLISHABLE_KEY;
    delete process.env.SUPABASE_ANON_KEY;
    assert.throws(
      () => loadConfig(),
      /SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY/,
    );
  });
});

test("configured Dodo webhooks require a strong Standard Webhooks secret", () => {
  withProductionEnvironment(() => {
    process.env.DODO_PAYMENTS_WEBHOOK_KEY = "whsec_c2hvcnQ=";
    assert.throws(() => loadConfig(), /DODO_PAYMENTS_WEBHOOK_KEY/);
  });
});

function withProductionEnvironment(run: () => void) {
  const names = [
    "NODE_ENV", "SMTP_HOST", "SUPABASE_URL", "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY", "APP_ORIGIN", "AUTH_ORIGIN", "ONBOARDING_ORIGIN",
    "DASHBOARD_ORIGIN", "PAYMENT_ORIGIN", "SESSION_COOKIE_DOMAIN",
    "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
    "GOOGLE_CALLBACK_URL", "AUTH_MAIL_ENCRYPTION_KEY",
    "GOOGLE_CALENDAR_CALLBACK_URL", "INTEGRATION_ENCRYPTION_KEY",
    "CRON_SECRET", "ACCURACY_UPLOAD_SECRET", "DODO_PAYMENTS_ENVIRONMENT",
    "DODO_PAYMENTS_WEBHOOK_KEY",
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env.NODE_ENV = "production";
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test-secret-key";
  process.env.APP_ORIGIN = "https://app.authenti8.example";
  process.env.AUTH_MAIL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
  process.env.CRON_SECRET = "test-mail-worker-secret";
  process.env.ACCURACY_UPLOAD_SECRET = "test-accuracy-upload-secret-32-bytes";
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CALLBACK_URL;
  delete process.env.AUTH_ORIGIN;
  delete process.env.ONBOARDING_ORIGIN;
  delete process.env.DASHBOARD_ORIGIN;
  delete process.env.PAYMENT_ORIGIN;
  delete process.env.SESSION_COOKIE_DOMAIN;
  delete process.env.DODO_PAYMENTS_ENVIRONMENT;
  delete process.env.DODO_PAYMENTS_WEBHOOK_KEY;
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
