import { createPublicKey, verify } from "node:crypto";
import type { WindowsRulePack } from "@authenti8/detection-rules";
import { canonicalJson } from "./event-chain.js";

export function verifyRulePack(pack: WindowsRulePack, encodedPublicKey: string) {
  assertRulePack(pack);
  if (Date.parse(pack.expiresAt) <= Date.now()) throw new Error("Detection rule pack has expired.");
  const { signature, ...unsigned } = pack;
  try {
    const key = createPublicKey({ key: Buffer.from(encodedPublicKey, "base64url"),
      format: "der", type: "spki" });
    const valid = key.asymmetricKeyType === "ed25519" && verify(null,
      Buffer.from(canonicalJson(unsigned)), key, Buffer.from(signature, "base64url"));
    if (!valid) throw new Error("Detection rule pack signature is invalid.");
  } catch (error) {
    if (error instanceof Error && error.message.includes("rule pack")) throw error;
    throw new Error("Detection rule pack signature is invalid.");
  }
  return pack;
}

function assertRulePack(pack: WindowsRulePack) {
  if (!pack || !validText(pack.version, 50) || !Number.isFinite(Date.parse(pack.expiresAt))
    || !Array.isArray(pack.rules) || pack.rules.length > 1_000
    || !validText(pack.signature, 256)) {
    throw new Error("Detection rule pack metadata is invalid.");
  }
  for (const rule of pack.rules) assertRule(rule);
}

function assertRule(rule: WindowsRulePack["rules"][number]) {
  if (!rule || !validText(rule.key, 100) || !validText(rule.family, 100)
    || !Number.isInteger(rule.version) || rule.version < 1 || typeof rule.enabled !== "boolean"
    || !validArray(rule.executableSha256, /^[a-f0-9]{64}$/i, 500)
    || !validArray(rule.signerThumbprints, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i, 500)
    || !validArray(rule.productNames, /^.{1,300}$/, 500)
    || (rule.virtualAudioNames !== undefined
      && !validArray(rule.virtualAudioNames, /^.{1,300}$/, 500))
    || (rule.overlayRequired !== undefined && typeof rule.overlayRequired !== "boolean")) {
    throw new Error("Detection rule pack contains an invalid rule.");
  }
}

function validArray(values: readonly string[], pattern: RegExp, maximum: number) {
  return Array.isArray(values) && values.length <= maximum
    && values.every((value) => typeof value === "string" && pattern.test(value));
}

function validText(value: string, maximum: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
