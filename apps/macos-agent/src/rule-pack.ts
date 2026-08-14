import { createPublicKey, verify } from "node:crypto";
import type { MacosRulePack } from "@authenti8/detection-rules";

export function verifyMacosRulePack(pack: MacosRulePack, publicKey: string) {
  if (!pack.version || Date.parse(pack.expiresAt) <= Date.now() || !Array.isArray(pack.rules)) {
    throw new Error("The macOS rule pack is invalid or expired.");
  }
  for (const rule of pack.rules) validateRule(rule);
  const { signature, ...unsigned } = pack;
  const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"),
    format: "der", type: "spki" });
  if (!verify(null, Buffer.from(canonicalJson(unsigned)), key, Buffer.from(signature, "base64url"))) {
    throw new Error("The macOS rule-pack signature is invalid.");
  }
  return pack;
}

function validateRule(rule: MacosRulePack["rules"][number]) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(rule.key)
    || rule.bundleIdentifiers.some((value) => !/^[A-Za-z0-9.-]{3,200}$/.test(value))
    || rule.teamIdentifiers.some((value) => !/^[A-Z0-9]{5,20}$/.test(value))
    || rule.executableSha256.some((value) => !/^[a-f0-9]{64}$/i.test(value))) {
    throw new Error("A macOS detection rule is malformed.");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(",")}}`;
}
