import type { WindowsRulePack } from "@authenti8/detection-rules";
import { verifyRulePack } from "./rule-pack-verifier.js";
import { checkForUpdate } from "./update-verifier.js";

declare const __AUTHENTI8_API_ORIGIN__: string | undefined;
declare const __AUTHENTI8_RULE_KEY__: string | undefined;
declare const __AUTHENTI8_UPDATE_KEY__: string | undefined;

export async function loadReleaseBootstrap(agentVersion: string) {
  const embeddedApi = typeof __AUTHENTI8_API_ORIGIN__ === "string" ? __AUTHENTI8_API_ORIGIN__ : undefined;
  const embeddedRule = typeof __AUTHENTI8_RULE_KEY__ === "string" ? __AUTHENTI8_RULE_KEY__ : undefined;
  const embeddedUpdate = typeof __AUTHENTI8_UPDATE_KEY__ === "string" ? __AUTHENTI8_UPDATE_KEY__ : undefined;
  const apiOrigin = configured("__AUTHENTI8_API_ORIGIN__", embeddedApi,
    process.env.AUTHENTI8_API_ORIGIN);
  const ruleKey = configured("__AUTHENTI8_RULE_KEY__", embeddedRule,
    process.env.AUTHENTI8_RULE_PACK_PUBLIC_KEY);
  const updateKey = configured("__AUTHENTI8_UPDATE_KEY__", embeddedUpdate,
    process.env.AUTHENTI8_UPDATE_PUBLIC_KEY);
  const update = await checkForUpdate(
    new URL("/api/v1/agent/releases/windows", apiOrigin), agentVersion, updateKey,
  );
  const rulePack = await loadWindowsRulePack(apiOrigin, ruleKey);
  return { apiOrigin, rulePack, rulePackPublicKey: ruleKey, update,
    refreshRulePack: () => loadWindowsRulePack(apiOrigin, ruleKey) };
}

export async function loadWindowsRulePack(apiOrigin: string, ruleKey: string) {
  const response = await fetch(new URL("/api/v1/agent/rules/windows", apiOrigin),
    { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("A verified Windows detection rule pack is unavailable.");
  return verifyRulePack(await response.json() as WindowsRulePack, ruleKey);
}

function configured(name: string, embeddedValue?: string, environmentValue?: string) {
  const value = embeddedValue || environmentValue;
  if (!value) throw new Error(`${name} is missing from this signed agent build.`);
  return value;
}
