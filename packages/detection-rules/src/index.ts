import type { AgentPlatform, TelemetryEventType } from "@authenti8/event-schemas";

export type DetectionRuleDefinition = {
  key: string;
  version: number;
  platform: AgentPlatform;
  acceptedEventTypes: readonly TelemetryEventType[];
  requiredSupportingSignals: readonly string[];
  enabled: boolean;
};
