import type {
  AudioEndpointEvidence, ProcessEvidence, TelemetryEnvelope, WindowEvidence,
} from "@authenti8/event-schemas";
import type { WindowsRulePack } from "@authenti8/detection-rules";

export type AgentConfiguration = {
  apiOrigin: string;
  enrollmentToken: string;
  agentVersion: string;
  rulePackVersion: string;
  pollIntervals?: { processes?: number; windows?: number; audio?: number };
  rulePack?: WindowsRulePack;
  rulePackPublicKey?: string;
  refreshRulePack?: () => Promise<WindowsRulePack>;
};

export type EnrolledIdentity = {
  deviceId: string;
  verificationSessionId: string;
  eligibleStart: string;
  eligibleEnd: string;
  privateKey: string;
  chainState?: { sequence: number; previousHash?: string };
  pendingEvent?: TelemetryEnvelope;
  monitoringStarted?: boolean;
};

export type PendingEnrollment = {
  publicKey: string;
  privateKey: string;
  challengeSignature: string;
  challengeExpiresAt: string;
};

export type SensorSnapshot = {
  processes: ProcessEvidence[];
  windows: WindowEvidence[];
  audioEndpoints: AudioEndpointEvidence[];
};

export type DetectionSignal = {
  family: string;
  confidence: "LOW" | "HIGH";
  identityEvidence: string[];
  activeUseEvidence: string[];
};

export type EventSender = (event: TelemetryEnvelope) => Promise<void>;

export type SignedUpdateManifest = {
  version: string;
  minimumVersion: string;
  downloadUrl: string;
  sha256: string;
  publishedAt: string;
  signature: string;
};
