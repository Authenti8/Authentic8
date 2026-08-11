import type { WindowsDetectionRule, WindowsRulePack } from "@authenti8/detection-rules";
import type { DetectionSignal, SensorSnapshot } from "./types.js";

export function matchSnapshot(snapshot: SensorSnapshot, pack?: WindowsRulePack) {
  if (!pack || Date.parse(pack.expiresAt) <= Date.now()) return [];
  return pack.rules.filter((rule) => rule.enabled).flatMap((rule) => matchRule(snapshot, rule));
}

function matchRule(snapshot: SensorSnapshot, rule: WindowsDetectionRule): DetectionSignal[] {
  const signals: DetectionSignal[] = [];
  for (const process of snapshot.processes) {
    const identity = identityEvidence(process, rule);
    if (identity.length === 0) continue;
    const active = activeEvidence(snapshot, process.processId, rule);
    signals.push({ family: rule.family, confidence: confidence(identity, active, rule),
      identityEvidence: identity, activeUseEvidence: active });
  }
  return signals;
}

function identityEvidence(process: SensorSnapshot["processes"][number], rule: WindowsDetectionRule) {
  const evidence: string[] = [];
  if (process.executableSha256 && includes(rule.executableSha256, process.executableSha256)) {
    evidence.push("EXACT_EXECUTABLE_HASH");
  }
  if (process.signerThumbprint && includes(rule.signerThumbprints, process.signerThumbprint)) {
    evidence.push("TRUSTED_SIGNER");
  }
  if (process.productName && includes(rule.productNames, process.productName)) {
    evidence.push("PRODUCT_METADATA");
  }
  return evidence;
}

function activeEvidence(snapshot: SensorSnapshot, processId: number, rule: WindowsDetectionRule) {
  const evidence: string[] = ["PROCESS_RUNNING"];
  const overlay = snapshot.windows.some((window) => window.ownerProcessId === processId
    && (window.transparent || window.topmost || window.captureExcluded));
  if (overlay) evidence.push("TOOL_OWNED_OVERLAY");
  const audio = snapshot.audioEndpoints.some((endpoint) =>
    rule.virtualAudioNames?.some((name) => endpoint.friendlyName.toLowerCase() === name.toLowerCase()));
  if (audio) evidence.push("ASSOCIATED_VIRTUAL_AUDIO");
  return evidence;
}

function confidence(identity: string[], active: string[], rule: WindowsDetectionRule) {
  const exact = identity.includes("EXACT_EXECUTABLE_HASH");
  const publisherProduct = identity.includes("TRUSTED_SIGNER") && identity.includes("PRODUCT_METADATA");
  const corroboratedActive = active.includes("TOOL_OWNED_OVERLAY")
    || active.includes("ASSOCIATED_VIRTUAL_AUDIO");
  const requiredOverlayPresent = !rule.overlayRequired || active.includes("TOOL_OWNED_OVERLAY");
  return (exact || publisherProduct) && corroboratedActive && requiredOverlayPresent
    ? "HIGH" as const : "LOW" as const;
}

function includes(values: readonly string[], candidate: string) {
  return values.some((value) => value.toLowerCase() === candidate.toLowerCase());
}
