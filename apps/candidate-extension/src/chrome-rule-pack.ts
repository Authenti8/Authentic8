import type { BrowserSignatureSet } from "./browser-monitor.js";

export async function loadChromeRulePack(url: string, publicKey: unknown) {
  if (typeof publicKey !== "string" || !/^[A-Za-z0-9_-]{40,200}$/.test(publicKey)) {
    throw new Error("Chrome rule-pack verification key is unavailable.");
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error("Chrome rule pack is unavailable.");
  const signedPack = await response.json() as unknown;
  return { signedPack, signatures: await verifyChromeRulePack(signedPack, publicKey) };
}

export async function verifyChromeRulePack(pack: unknown, publicKey: string) {
  assertPack(pack);
  const { signature, ...unsigned } = pack;
  const key = await crypto.subtle.importKey("spki", decode(publicKey), { name: "Ed25519" }, false,
    ["verify"]);
  const verified = await crypto.subtle.verify("Ed25519", key, decode(signature),
    new TextEncoder().encode(canonicalJson(unsigned)));
  if (!verified) throw new Error("Chrome rule-pack signature is invalid.");
  const rules: BrowserSignatureSet["rules"] = Object.fromEntries(pack.rules.flatMap((rule) =>
    rule.enabled ? rule.extensionIds.map((id) => [id, { ruleKey: rule.key,
      ruleVersion: rule.version }]) : []));
  return { rulePackVersion: pack.version, rules };
}

function assertPack(pack: unknown): asserts pack is ChromeRulePack {
  const candidate = pack as ChromeRulePack;
  const expiry = candidate && typeof candidate.expiresAt === "string"
    ? Date.parse(candidate.expiresAt) : Number.NaN;
  if (!candidate || !label(candidate.version, 100) || !Number.isFinite(expiry)
    || expiry <= Date.now() || !label(candidate.signature, 256)
    || !Array.isArray(candidate.rules) || candidate.rules.length > 1_000) {
    throw new Error("Chrome rule-pack metadata is invalid.");
  }
  const extensionIds = new Set<string>();
  for (const rule of candidate.rules) {
    if (!rule || !label(rule.key, 100) || !Number.isSafeInteger(rule.version) || rule.version < 1
      || typeof rule.enabled !== "boolean" || !Array.isArray(rule.extensionIds)
      || rule.extensionIds.length > 500
      || !rule.extensionIds.every((id) => typeof id === "string" && /^[a-p]{32}$/.test(id))) {
      throw new Error("Chrome rule pack contains an invalid rule.");
    }
    for (const id of rule.extensionIds) {
      if (extensionIds.has(id)) throw new Error("Chrome rule pack contains a duplicate extension ID.");
      extensionIds.add(id);
    }
  }
}

function decode(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(",")}}`;
}

function label(value: unknown, maximum: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

type ChromeRulePack = { version: string; expiresAt: string; signature: string; rules: Array<{
  key: string; version: number; enabled: boolean; extensionIds: string[] }> };
