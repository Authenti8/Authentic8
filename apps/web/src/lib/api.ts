import type { ApiErrorResponse } from "@authenti8/contracts";

export async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as ApiErrorResponse & {
    message?: string | string[];
  };
  if (!response.ok) throw new Error(normalizeError(body));
  return body as T;
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { credentials: "include" });
  const body = (await response.json().catch(() => ({}))) as ApiErrorResponse & {
    message?: string | string[];
  };
  if (!response.ok) throw new Error(normalizeError(body));
  return body as T;
}

function normalizeError(body: ApiErrorResponse & { message?: string | string[] }) {
  if (Array.isArray(body.message)) return body.message[0] ?? "Please check your details.";
  if (body.message) return body.message;
  return body.error || "Something went wrong. Please try again.";
}
