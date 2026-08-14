import type { MacosAgentConfiguration } from "./types.js";

export function parseActivationUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "authenti8:" || url.hostname !== "verify") {
    throw new Error("The Authenti8 activation URL is invalid.");
  }
  const token = url.searchParams.get("token") ?? "";
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("The enrollment token is invalid.");
  return token;
}

export function validateConfiguration(config: MacosAgentConfiguration) {
  const origin = new URL(config.apiOrigin);
  const local = ["localhost", "127.0.0.1", "::1"].includes(origin.hostname);
  if (origin.protocol !== "https:" && !(local && origin.protocol === "http:")) {
    throw new Error("Authenti8 Verify requires a secure API origin.");
  }
  if (!/^[a-f0-9]{64}$/.test(config.enrollmentToken)
    || !version(config.agentVersion) || !version(config.rulePack.version)) {
    throw new Error("Agent configuration is invalid.");
  }
  if (Date.parse(config.rulePack.expiresAt) <= Date.now()) throw new Error("Rule pack is expired.");
}

function version(value: string) { return /^[A-Za-z0-9._-]{1,50}$/.test(value); }
