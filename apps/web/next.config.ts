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
const apiOrigin = deploymentUrl("API_ORIGIN", "http://localhost:4000");

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/:path*` }];
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
