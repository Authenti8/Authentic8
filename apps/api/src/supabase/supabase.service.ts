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
}

function requestHeaders(key: string) {
  const headers: Record<string, string> = {
    apikey: key,
    "content-type": "application/json",
  };
  if (!key.startsWith("sb_secret_")) headers.authorization = `Bearer ${key}`;
  return headers;
}
