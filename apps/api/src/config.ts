import { resolve } from "node:path";
import { config as loadEnvironment } from "dotenv";
import { decodeDodoWebhookSecret } from "./billing/dodo-secret.js";

loadEnvironment({ path: resolve(process.cwd(), "../../.env"), quiet: true });
loadEnvironment({ path: resolve(process.cwd(), ".env"), quiet: true, override: false });

export type AppConfig = ReturnType<typeof loadConfig>;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig() {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const supabaseUrl = supabaseApiUrl(nodeEnv);
  const supabaseSecretKey = supabaseServerKey();
  const origins = applicationOrigins(nodeEnv);
  const google = googleConfig(nodeEnv, origins.authOrigin);
  const googleCalendar = googleCalendarConfig(nodeEnv, origins.dashboardOrigin);
  const dodo = dodoConfig(nodeEnv);
  const supabasePublishableKey = supabaseBrowserKey(Boolean(google.googleClientId));
  const cronSecret = mailWorkerSecret(nodeEnv);
  const accuracyUploadSecret = internalSecret("ACCURACY_UPLOAD_SECRET", nodeEnv);
  const smtp = {
    host: process.env.SMTP_HOST?.trim() ?? "",
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER?.trim() ?? "",
    password: process.env.SMTP_PASSWORD ?? "",
    from: process.env.SMTP_FROM ?? "Authenti8 <no-reply@authenti8.com>",
  };
  if (nodeEnv === "production" && !smtp.host) {
    throw new Error("Missing required production environment variable: SMTP_HOST");
  }
  const mailEncryptionKey = encryptionKey(nodeEnv);
  return {
    nodeEnv,
    isProduction: nodeEnv === "production",
    port: Number(process.env.API_PORT ?? 4000),
    trustedProxies: (process.env.TRUSTED_PROXIES ?? "loopback")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    ...origins,
    supabaseUrl,
    supabaseSecretKey,
    supabasePublishableKey,
    cronSecret,
    accuracyUploadSecret,
    ...google,
    ...googleCalendar,
    dodo,
    smtp,
    mailEncryptionKey,
  };
}

function internalSecret(name: string, nodeEnv: string) {
  const value = process.env[name]?.trim() ?? "";
  if (nodeEnv === "production" && value.length < 32) {
    throw new Error(`${name} must contain at least 32 characters in production`);
  }
  return value || `development-${name.toLowerCase()}`;
}

function googleCalendarConfig(nodeEnv: string, appOrigin: string) {
  const fallback = `${appOrigin}/api/v1/integrations/google/callback`;
  const value = process.env.GOOGLE_CALENDAR_CALLBACK_URL?.trim();
  const googleCalendarCallbackUrl = nodeEnv === "production"
    ? productionUrl("GOOGLE_CALENDAR_CALLBACK_URL", value || fallback)
    : value || fallback;
  const integrationEncryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY?.trim()
    || process.env.AUTH_MAIL_ENCRYPTION_KEY?.trim() || "";
  if (integrationEncryptionKey && Buffer.from(integrationEncryptionKey, "base64").length !== 32) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return { googleCalendarCallbackUrl, integrationEncryptionKey };
}

function dodoConfig(nodeEnv: string) {
  const mode = process.env.DODO_PAYMENTS_ENVIRONMENT?.trim() || "test_mode";
  const webhookKey = process.env.DODO_PAYMENTS_WEBHOOK_KEY?.trim() ?? "";
  if (!["test_mode", "live_mode"].includes(mode)) {
    throw new Error("DODO_PAYMENTS_ENVIRONMENT must be test_mode or live_mode");
  }
  if (nodeEnv !== "production" && mode === "live_mode") {
    throw new Error("Dodo live mode is not allowed outside production");
  }
  if (nodeEnv === "production" && webhookKey && !decodeDodoWebhookSecret(webhookKey)) {
    throw new Error("DODO_PAYMENTS_WEBHOOK_KEY must be a valid whsec_ secret of at least 32 bytes");
  }
  return {
    apiKey: process.env.DODO_PAYMENTS_API_KEY?.trim() ?? "",
    webhookKey,
    professionalProductId: process.env.DODO_PROFESSIONAL_PRODUCT_ID?.trim() ?? "",
    extraInterviewProductId: process.env.DODO_EXTRA_INTERVIEW_PRODUCT_ID?.trim() ?? "",
    baseUrl: mode === "live_mode" ? "https://live.dodopayments.com" : "https://test.dodopayments.com",
  };
}

function supabaseBrowserKey(requiredForGoogle: boolean) {
  const key = process.env.SUPABASE_PUBLISHABLE_KEY?.trim()
    || process.env.SUPABASE_ANON_KEY?.trim() || "";
  if (requiredForGoogle && !key) {
    throw new Error(
      "Google login requires SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY",
    );
  }
  return key;
}

function mailWorkerSecret(nodeEnv: string) {
  const value = process.env.CRON_SECRET?.trim() ?? "";
  if (nodeEnv === "production" && value.length < 16) {
    throw new Error("CRON_SECRET must contain at least 16 characters in production");
  }
  return value || "development-cron-secret";
}

function encryptionKey(nodeEnv: string) {
  const value = process.env.AUTH_MAIL_ENCRYPTION_KEY?.trim() ?? "";
  if (nodeEnv === "production" && !value) {
    throw new Error("Missing required production environment variable: AUTH_MAIL_ENCRYPTION_KEY");
  }
  if (value && Buffer.from(value, "base64").length !== 32) {
    throw new Error("AUTH_MAIL_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return value;
}

function supabaseApiUrl(nodeEnv: string) {
  const value = required("SUPABASE_URL");
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const localHttp = nodeEnv !== "production" && loopback && url.protocol === "http:";
    if (url.protocol !== "https:" && !localHttp) throw new Error("insecure URL");
    if (url.username || url.password) throw new Error("credentials in URL");
    return url.origin;
  } catch {
    throw new Error(
      "SUPABASE_URL must use HTTPS, except for an HTTP loopback URL in development",
    );
  }
}

function supabaseServerKey() {
  const key = process.env.SUPABASE_SECRET_KEY?.trim()
    || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) {
    throw new Error(
      "Missing required environment variable: SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return key;
}

function applicationOrigins(nodeEnv: string) {
  const appOrigin = originValue("APP_ORIGIN", nodeEnv, "http://localhost:3000");
  const authOrigin = originValue("AUTH_ORIGIN", nodeEnv, appOrigin);
  const onboardingOrigin = originValue("ONBOARDING_ORIGIN", nodeEnv, appOrigin);
  const dashboardOrigin = originValue("DASHBOARD_ORIGIN", nodeEnv, appOrigin);
  const paymentOrigin = originValue("PAYMENT_ORIGIN", nodeEnv, dashboardOrigin);
  const cookieDomain = process.env.SESSION_COOKIE_DOMAIN?.trim() || undefined;
  const allowedOrigins = [...new Set([
    appOrigin, authOrigin, onboardingOrigin, dashboardOrigin, paymentOrigin,
  ])];
  if (nodeEnv === "production" && allowedOrigins.length > 1 && !cookieDomain) {
    throw new Error("SESSION_COOKIE_DOMAIN is required for production subdomains");
  }
  if (cookieDomain && (!cookieDomain.startsWith(".") || cookieDomain.includes(":"))) {
    throw new Error("SESSION_COOKIE_DOMAIN must be a parent domain such as .authenti8.com");
  }
  const parentHost = cookieDomain?.slice(1);
  if (cookieDomain && allowedOrigins.some((origin) => {
    const hostname = new URL(origin).hostname;
    return hostname !== parentHost && !hostname.endsWith(cookieDomain);
  })) {
    throw new Error("Every application origin must belong to SESSION_COOKIE_DOMAIN");
  }
  return {
    appOrigin, authOrigin, onboardingOrigin, dashboardOrigin, paymentOrigin,
    allowedOrigins, cookieDomain,
  };
}

function googleConfig(nodeEnv: string, authOrigin: string) {
  const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const configured = Boolean(googleClientId || googleClientSecret);
  if (configured && (!googleClientId || !googleClientSecret)) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together");
  }
  const fallback = `${authOrigin}/api/v1/auth/google/callback`;
  const value = process.env.GOOGLE_CALLBACK_URL?.trim();
  const googleCallbackUrl = nodeEnv === "production" && configured
    ? productionUrl("GOOGLE_CALLBACK_URL", value || fallback)
    : value || fallback;
  return { googleClientId, googleClientSecret, googleCallbackUrl };
}

function originValue(name: string, nodeEnv: string, fallback: string) {
  const value = process.env[name]?.trim() || fallback;
  if (nodeEnv !== "production") return new URL(value).origin;
  const url = new URL(productionUrl(name, value));
  if (url.pathname !== "/") throw new Error(`${name} must not include a path`);
  return url.origin;
}

function productionUrl(name: string, value: string | undefined) {
  if (!value) throw new Error(`Missing required production environment variable: ${name}`);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(url.hostname)) {
      throw new Error("not a public HTTPS URL");
    }
    return url.origin + url.pathname.replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be a public HTTPS URL in production`);
  }
}
