import type { MacosRulePack } from "@authenti8/detection-rules";
import type { TelemetryEnvelope } from "@authenti8/event-schemas";

export type MacosAgentConfiguration = {
  apiOrigin: string;
  enrollmentToken: string;
  agentVersion: string;
  rulePack: MacosRulePack;
  rulePackPublicKey: string;
  refreshRulePack?: () => Promise<MacosRulePack>;
  sensorPath?: string;
};

export type MacosApplication = { processId: number; bundleIdentifier?: string;
  executableSha256?: string; teamIdentifier?: string; version?: string; launchTime?: string;
  identityKey?: string };
export type MacosWindow = { ownerProcessId: number; ownerBundleIdentifier?: string;
  windowIdHash: string; titleHash: string; layer: number; alpha: number; onScreen: boolean;
  bounds: { left: number; top: number; width: number; height: number } };
export type MacosAudioDevice = { deviceIdHash: string; name: string; provider?: string;
  direction: "CAPTURE" | "RENDER"; virtual: boolean; isDefault: boolean };
export type MacosPermissions = { accessibility: boolean; screenRecording: boolean };
export type MacosSnapshot = { applications: MacosApplication[]; windows: MacosWindow[];
  audioDevices: MacosAudioDevice[]; permissions: MacosPermissions };

export type MacosIdentity = { deviceId: string; verificationSessionId: string;
  eligibleStart: string; eligibleEnd: string; privateKey: string;
  chainState?: { sequence: number; previousHash?: string }; pendingEvents?: TelemetryEnvelope[];
  monitoringStarted?: boolean };
