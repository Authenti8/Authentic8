export const telemetrySchemaVersion = 1 as const;

export type AgentPlatform = "WINDOWS" | "MACOS" | "CHROME";
export type TelemetryEventType =
  | "HEARTBEAT"
  | "MONITORING_STARTED"
  | "MONITORING_STOPPED"
  | "PROCESS_OBSERVED"
  | "WINDOW_OBSERVED"
  | "PERMISSION_CHANGED";

export type TelemetryEnvelope = {
  schemaVersion: typeof telemetrySchemaVersion;
  eventId: string;
  verificationSessionId: string;
  sequenceNumber: number;
  eventType: TelemetryEventType;
  eventTimestamp: string;
  monotonicTimestamp: number;
  platform: AgentPlatform;
  agentVersion: string;
  rulePackVersion: string;
  payload: Readonly<Record<string, unknown>>;
  payloadHash: string;
  previousEventHash?: string;
  signature: string;
};
