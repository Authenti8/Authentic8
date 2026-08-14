import type {
  BrowserExtensionMatchEvidence, BrowserProfileHealthEvidence,
} from "@authenti8/event-schemas";

export type ExtensionDescriptor = {
  id: string;
  version: string;
  enabled: boolean;
  installType: string;
};

export type BrowserSignature = { ruleKey: string; ruleVersion: number };
export type BrowserSignatureSet = { rulePackVersion: string;
  rules: Readonly<Record<string, BrowserSignature>> };

export type BrowserEvidence =
  | { eventType: "BROWSER_EXTENSION_MATCH" | "BROWSER_EXTENSION_CHANGED";
    payload: BrowserExtensionMatchEvidence }
  | { eventType: "BROWSER_PROFILE_HEALTH"; payload: BrowserProfileHealthEvidence };

export function matchExtensions(
  extensions: readonly ExtensionDescriptor[], signatures: BrowserSignatureSet,
) {
  const matches: BrowserEvidence[] = [];
  for (const extension of extensions) {
    const rule = signatures.rules[normalizeId(extension.id)];
    if (!rule) continue;
    matches.push({ eventType: "BROWSER_EXTENSION_MATCH", payload: {
      extensionId: normalizeId(extension.id), version: safeVersion(extension.version),
      enabled: extension.enabled, installationType: installationType(extension.installType),
      ruleKey: rule.ruleKey, ruleVersion: rule.ruleVersion,
      rulePackVersion: signatures.rulePackVersion,
    } });
  }
  return matches;
}

export function changedExtension(
  extension: ExtensionDescriptor, signatures: BrowserSignatureSet,
) {
  const match = matchExtensions([extension], signatures)[0];
  if (!match || match.eventType === "BROWSER_PROFILE_HEALTH") return undefined;
  return { eventType: "BROWSER_EXTENSION_CHANGED" as const, payload: match.payload };
}

export function validSignatures(value: unknown): BrowserSignatureSet {
  const empty = { rulePackVersion: "", rules: {} };
  if (!record(value) || !validLabel(value.rulePackVersion) || !record(value.rules)) return empty;
  const result: Record<string, BrowserSignature> = {};
  for (const [id, candidate] of Object.entries(value.rules)) {
    if (/^[a-p]{32}$/.test(id) && record(candidate) && validLabel(candidate.ruleKey)
      && Number.isSafeInteger(candidate.ruleVersion) && Number(candidate.ruleVersion) > 0) {
      result[id] = { ruleKey: String(candidate.ruleKey), ruleVersion: Number(candidate.ruleVersion) };
    }
  }
  return { rulePackVersion: String(value.rulePackVersion), rules: result };
}

export function hasRecentProfileProof(lastProofAt: unknown, now = Date.now()) {
  return typeof lastProofAt === "number" && Number.isFinite(lastProofAt)
    && lastProofAt <= now && now - lastProofAt <= 15_000;
}

function normalizeId(value: string) { return value.trim().toLowerCase(); }

function safeVersion(value: string) {
  return /^[A-Za-z0-9._-]{1,50}$/.test(value) ? value : "UNKNOWN";
}

function installationType(value: string): BrowserExtensionMatchEvidence["installationType"] {
  if (value === "admin") return "ADMIN";
  if (value === "development") return "DEVELOPMENT";
  if (value === "normal") return "NORMAL";
  return "OTHER";
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validLabel(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(value);
}
