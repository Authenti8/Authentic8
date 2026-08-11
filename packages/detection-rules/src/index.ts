import type { AgentPlatform, TelemetryEventType } from "@authenti8/event-schemas";

export type DetectionRuleDefinition = {
  key: string;
  version: number;
  platform: AgentPlatform;
  acceptedEventTypes: readonly TelemetryEventType[];
  requiredSupportingSignals: readonly string[];
  enabled: boolean;
};

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
