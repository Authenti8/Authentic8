import { Injectable } from "@nestjs/common";
import { loadConfig } from "../config.js";

@Injectable()
export class SupabaseService {
  private readonly config = loadConfig();

  async rpc<T>(name: string, input: Record<string, unknown> = {}) {
    const response = await fetch(`${this.config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: requestHeaders(this.config.supabaseSecretKey),
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Supabase RPC ${name} failed (${response.status}): ${error.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  async signInWithGoogleIdToken(idToken: string, accessToken: string) {
    const response = await fetch(`${this.config.supabaseUrl}/auth/v1/token?grant_type=id_token`, {
      method: "POST",
      headers: authHeaders(this.config.supabasePublishableKey),
      body: JSON.stringify({
        provider: "google", id_token: idToken, access_token: accessToken,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Supabase Auth Google exchange failed (${response.status}): ${error.slice(0, 300)}`);
    }
    const result = (await response.json()) as SupabaseAuthResponse;
    if (!result.user?.id || !result.user.email || !result.access_token) {
      throw new Error("Supabase Auth Google exchange returned no user identity");
    }
    await this.revokeAuthSession(result.access_token);
    return { id: result.user.id, email: result.user.email.trim().toLowerCase() };
  }

  private async revokeAuthSession(accessToken: string) {
    const response = await fetch(`${this.config.supabaseUrl}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: sessionHeaders(this.config.supabasePublishableKey, accessToken),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Supabase Auth session cleanup failed (${response.status}): ${error.slice(0, 300)}`);
    }
  }
}

type SupabaseAuthResponse = {
  access_token?: string;
  user?: { id?: string; email?: string };
};

function requestHeaders(key: string) {
  const headers: Record<string, string> = {
    apikey: key,
    "content-type": "application/json",
  };
  if (!key.startsWith("sb_secret_")) headers.authorization = `Bearer ${key}`;
  return headers;
}

function authHeaders(key: string) {
  return { apikey: key, "content-type": "application/json" };
}

function sessionHeaders(key: string, accessToken: string) {
  return { ...authHeaders(key), authorization: `Bearer ${accessToken}` };
}
