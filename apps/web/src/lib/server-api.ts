import "server-only";
import type { SessionResponse } from "@authenti8/contracts";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const apiBaseUrl = process.env.NODE_ENV === "production"
  ? `${requiredOrigin("APP_ORIGIN")}/api`
  : process.env.API_ORIGIN ?? "http://localhost:4000";

export async function getSession() {
  const cookieHeader = (await cookies()).toString();
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/v1/auth/session`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    });
  } catch {
    throw new Error("Authenti8 API is unavailable.");
  }
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Authenti8 session could not be loaded.");
  return (await response.json()) as SessionResponse;
}

export async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

function requiredOrigin(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return new URL(value).origin;
}
