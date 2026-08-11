export const telemetrySchemaVersion = 1 as const;

export type AgentPlatform = "WINDOWS" | "MACOS" | "CHROME";
export type TelemetryEventType =
  | "HEARTBEAT"
  | "MONITORING_STARTED"
  | "MONITORING_STOPPED"
  | "PROCESS_OBSERVED"
  | "WINDOW_OBSERVED"
  | "AUDIO_ENDPOINT_OBSERVED"
  | "DETECTION_SIGNAL"
  | "PERMISSION_CHANGED";

export type ProcessEvidence = {
  processId: number;
  executableName: string;
  executablePathHash?: string;
  executableSha256?: string;
  signerSubject?: string;
  signerThumbprint?: string;
  productName?: string;
  fileVersion?: string;
  parentProcessId?: number;
  processStartTime?: string;
  change: "STARTED" | "STOPPED" | "CHANGED";
};

export type WindowEvidence = {
  windowIdHash: string;
  ownerProcessId: number;
  visible: boolean;
  topmost: boolean;
  layered: boolean;
  transparent: boolean;
  captureExcluded: boolean;
  titleHash: string;
  classHash: string;
  bounds: { left: number; top: number; width: number; height: number };
};

export type AudioEndpointEvidence = {
  endpointIdHash: string;
  friendlyName: string;
  provider?: string;
  direction: "CAPTURE" | "RENDER";
  state: "ACTIVE" | "DISABLED" | "NOT_PRESENT" | "UNPLUGGED";
  isDefaultCommunications: boolean;
  change: "BASELINE" | "ADDED" | "REMOVED" | "DEFAULT_CHANGED" | "CHANGED";
};

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
