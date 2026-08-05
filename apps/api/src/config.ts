import { resolve } from "node:path";
import { config as loadEnvironment } from "dotenv";

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
  const databaseUrl = required("DATABASE_URL");
  const appOrigin = applicationOrigin(nodeEnv);
  const google = googleConfig(nodeEnv);
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
  if (nodeEnv === "production" && databaseRole(databaseUrl) !== "authenti8_backend") {
    throw new Error("DATABASE_URL must use the non-owner authenti8_backend role in production");
  }
  if (nodeEnv === "production" && process.env.DATABASE_MIGRATION_URL?.trim()) {
    throw new Error("DATABASE_MIGRATION_URL must not be available to the running API");
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
    appOrigin,
    databaseUrl,
    databasePoolMax: Number(process.env.DATABASE_POOL_MAX ?? 5),
    ...google,
    smtp,
    mailEncryptionKey,
  };
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

export function loadMigrationConfig() {
  loadEnvironment({
    path: resolve(process.cwd(), "../../.env.migration"),
    quiet: true,
    override: true,
  });
  loadEnvironment({
    path: resolve(process.cwd(), ".env.migration"),
    quiet: true,
    override: true,
  });
  return { databaseUrl: required("DATABASE_MIGRATION_URL") };
}

function databaseRole(connectionString: string) {
  try {
    return decodeURIComponent(new URL(connectionString).username).split(".")[0];
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL");
  }
}

function applicationOrigin(nodeEnv: string) {
  const value = process.env.APP_ORIGIN?.trim();
  if (nodeEnv !== "production") return value || "http://localhost:3000";
  const productionOrigin = productionUrl("APP_ORIGIN", value);
  const url = new URL(productionOrigin);
  if (url.pathname !== "/") {
    throw new Error("APP_ORIGIN must not include a path");
  }
  return url.origin;
}

function googleConfig(nodeEnv: string) {
  const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const configured = Boolean(googleClientId || googleClientSecret);
  if (configured && (!googleClientId || !googleClientSecret)) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together");
  }
  const fallback = "http://localhost:3000/api/v1/auth/google/callback";
  const value = process.env.GOOGLE_CALLBACK_URL?.trim();
  const googleCallbackUrl = nodeEnv === "production" && configured
    ? productionUrl("GOOGLE_CALLBACK_URL", value)
    : value || fallback;
  return { googleClientId, googleClientSecret, googleCallbackUrl };
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
