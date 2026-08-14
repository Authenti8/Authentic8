import type { MacosRulePack } from "@authenti8/detection-rules";
import type { MacosSnapshot } from "./types.js";

export function matchMacosSnapshot(snapshot: MacosSnapshot, pack: MacosRulePack) {
  const matches: Match[] = [];
  for (const rule of pack.rules) {
    if (!rule.enabled) continue;
    for (const application of snapshot.applications) {
      const identity = identityEvidence(application, rule);
      if (!identity.length) continue;
      const overlay = snapshot.windows.some((window) => window.ownerProcessId === application.processId
        && window.onScreen && (window.layer > 0 || window.alpha < 1));
      const audio = snapshot.audioDevices.some((device) => device.virtual
        && rule.virtualAudioNames?.some((name) => name === device.name));
      matches.push({ ruleKey: rule.key, ruleVersion: rule.version, family: rule.family,
        processId: application.processId,
        identityEvidence: identity, activeUseEvidence: [overlay && "OVERLAY", audio && "AUDIO_ROUTE"]
          .filter(Boolean) as string[], confirmed: rule.overlayRequired ? overlay : overlay || audio });
    }
  }
  return matches;
}

function identityEvidence(application: MacosSnapshot["applications"][number],
  rule: MacosRulePack["rules"][number]) {
  const evidence: string[] = [];
  if (application.bundleIdentifier && rule.bundleIdentifiers.includes(application.bundleIdentifier)) {
    evidence.push("BUNDLE_IDENTIFIER");
  }
  if (application.teamIdentifier && rule.teamIdentifiers.includes(application.teamIdentifier)) {
    evidence.push("TEAM_IDENTIFIER");
  }
  if (application.executableSha256 && rule.executableSha256.includes(application.executableSha256)) {
    evidence.push("EXECUTABLE_SHA256");
  }
  return evidence;
}

type Match = { ruleKey: string; ruleVersion: number; family: string; processId: number;
  identityEvidence: string[];
  activeUseEvidence: string[]; confirmed: boolean };
