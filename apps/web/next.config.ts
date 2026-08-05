import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";
import { resolve } from "node:path";

loadEnvConfig(
  resolve(process.cwd(), "../.."),
  process.env.NODE_ENV !== "production",
  undefined,
  true,
);

deploymentUrl("APP_ORIGIN", "http://localhost:3000");
const isProduction = process.env.NODE_ENV === "production";
const developmentApiOrigin = isProduction
  ? undefined
  : deploymentUrl("API_ORIGIN", "http://localhost:4000");

const nextConfig: NextConfig = {
  outputFileTracingRoot: resolve(process.cwd(), "../.."),
  transpilePackages: [
    "@authenti8/api",
    "@authenti8/contracts",
    "@authenti8/event-schemas",
  ],
  async rewrites() {
    if (developmentApiOrigin) {
      return [
        { source: "/api/:path*", destination: `${developmentApiOrigin}/:path*` },
        { source: "/v1/:path*", destination: `${developmentApiOrigin}/v1/:path*` },
      ];
    }
    return [{ source: "/v1/:path*", destination: "/api/v1/:path*" }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;

function deploymentUrl(name: string, developmentFallback: string) {
  const value = process.env[name]?.trim();
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`Missing required production environment variable: ${name}`);
  }
  try {
    return new URL(value || developmentFallback).origin;
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}
