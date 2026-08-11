import type { AgentConfiguration } from "./types.js";

export function parseActivationUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "authenti8:" || url.hostname !== "verify") {
    throw new Error("The Authenti8 activation URL is invalid.");
  }
  const token = url.searchParams.get("token") ?? "";
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("The enrollment token is invalid.");
  return token;
}

export function validateConfiguration(config: AgentConfiguration) {
  const origin = new URL(config.apiOrigin);
  const local = ["localhost", "127.0.0.1", "::1"].includes(origin.hostname);
  if (origin.protocol !== "https:" && !(local && origin.protocol === "http:")) {
    throw new Error("Authenti8 Verify requires a secure API origin.");
  }
  if (!/^[a-f0-9]{64}$/.test(config.enrollmentToken)) {
    throw new Error("The enrollment token is invalid.");
  }
  if (!validVersion(config.agentVersion) || !validVersion(config.rulePackVersion)) {
    throw new Error("Agent and rule-pack versions are required.");
  }
}

function validVersion(value: string) {
  return value.length > 0 && value.length <= 50 && /^[A-Za-z0-9._-]+$/.test(value);
}
