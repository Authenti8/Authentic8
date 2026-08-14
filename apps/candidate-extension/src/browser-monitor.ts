import type {
  BrowserExtensionMatchEvidence, BrowserProfileHealthEvidence,
} from "@authenti8/event-schemas";

export type ExtensionDescriptor = {
  id: string;
  version: string;
  enabled: boolean;
  installType: string;
};

export type BrowserEvidence =
  | { eventType: "BROWSER_EXTENSION_MATCH" | "BROWSER_EXTENSION_CHANGED";
    payload: BrowserExtensionMatchEvidence }
  | { eventType: "BROWSER_PROFILE_HEALTH"; payload: BrowserProfileHealthEvidence };

export function matchExtensions(
  extensions: readonly ExtensionDescriptor[], signatures: Readonly<Record<string, string>>,
) {
  const matches: BrowserEvidence[] = [];
  for (const extension of extensions) {
    const ruleKey = signatures[normalizeId(extension.id)];
    if (!ruleKey) continue;
    matches.push({ eventType: "BROWSER_EXTENSION_MATCH", payload: {
      extensionId: normalizeId(extension.id), version: safeVersion(extension.version),
      enabled: extension.enabled, installationType: installationType(extension.installType), ruleKey,
    } });
  }
  return matches;
}

export function changedExtension(
  extension: ExtensionDescriptor, signatures: Readonly<Record<string, string>>,
) {
  const match = matchExtensions([extension], signatures)[0];
  if (!match || match.eventType === "BROWSER_PROFILE_HEALTH") return undefined;
  return { eventType: "BROWSER_EXTENSION_CHANGED" as const, payload: match.payload };
}

export function validSignatures(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [id, rule] of Object.entries(value)) {
    if (/^[a-p]{32}$/.test(id) && typeof rule === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(rule)) {
      result[id] = rule;
    }
  }
  return result;
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
