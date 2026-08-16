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

export async function getServerApi<T>(path: string) {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${apiBaseUrl}/v1${path}`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  });
  if (response.status === 401) redirect("/login");
  if (!response.ok) throw new Error(`Authenti8 API request failed (${response.status}).`);
  return response.json() as Promise<T>;
}

export async function postServerApi<T>(path: string, body: unknown) {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${apiBaseUrl}/v1${path}`, {
    method: "POST", headers: { cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify(body), cache: "no-store",
  });
  if (response.status === 401) redirect("/login");
  if (!response.ok) throw new Error(`Authenti8 API request failed (${response.status}).`);
  return response.json() as Promise<T>;
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
