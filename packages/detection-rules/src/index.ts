import type { AgentPlatform, TelemetryEventType } from "@authenti8/event-schemas";

export type DetectionRuleDefinition = {
  key: string;
  version: number;
  platform: AgentPlatform;
  acceptedEventTypes: readonly TelemetryEventType[];
  requiredSupportingSignals: readonly string[];
  enabled: boolean;
};

export type DetectionConfidence = "HIGH" | "MEDIUM" | "LOW";
export type DetectionSignal = {
  eventId: string;
  ruleKey: string;
  ruleVersion: number;
  rulePackVersion: string;
  confidence: DetectionConfidence;
  technicalEvidence: readonly string[];
  requiredSupportingSignals: readonly string[];
};

export type DetectionDecision = {
  result: "CONFIRMED" | "NOT_DETECTED";
  confirmed: readonly DetectionSignal[];
  retainedSignals: readonly DetectionSignal[];
};

export function decideDetection(signals: readonly DetectionSignal[]): DetectionDecision {
  const high = signals.filter((signal) => signal.confidence === "HIGH"
    && signal.technicalEvidence.length > 0);
  const medium = signals.filter((signal) => signal.confidence === "MEDIUM"
    && hasRequiredSupport(signal, signals));
  const confirmed = uniqueSignals([...high, ...medium]);
  return { result: confirmed.length ? "CONFIRMED" : "NOT_DETECTED", confirmed,
    retainedSignals: signals.filter((signal) => !confirmed.includes(signal)) };
}

function hasRequiredSupport(signal: DetectionSignal, signals: readonly DetectionSignal[]) {
  return signal.technicalEvidence.length > 0 && signal.requiredSupportingSignals.length > 0
    && signal.requiredSupportingSignals.every((key) => signals.some((candidate) =>
      candidate !== signal && candidate.ruleKey === key && candidate.confidence === "MEDIUM"
      && candidate.technicalEvidence.length > 0));
}

function uniqueSignals(signals: readonly DetectionSignal[]) {
  return signals.filter((signal, index) => signals.findIndex((candidate) =>
    candidate.eventId === signal.eventId && candidate.ruleKey === signal.ruleKey) === index);
}

export type WindowsDetectionRule = {
  key: string;
  family: string;
  version: number;
  enabled: boolean;
  executableSha256: readonly string[];
  signerThumbprints: readonly string[];
  productNames: readonly string[];
  overlayRequired?: boolean;
  virtualAudioNames?: readonly string[];
};

export type WindowsRulePack = {
  version: string;
  expiresAt: string;
  rules: readonly WindowsDetectionRule[];
  signature: string;
};

export type MacosDetectionRule = {
  key: string;
  family: string;
  version: number;
  enabled: boolean;
  bundleIdentifiers: readonly string[];
  teamIdentifiers: readonly string[];
  executableSha256: readonly string[];
  overlayRequired?: boolean;
  virtualAudioNames?: readonly string[];
};

export type MacosRulePack = {
  version: string;
  expiresAt: string;
  rules: readonly MacosDetectionRule[];
  signature: string;
};
