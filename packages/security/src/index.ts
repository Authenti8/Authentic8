export const evidenceSignatureAlgorithm = "Ed25519" as const;
export const enrollmentKeyAlgorithm = "Ed25519" as const;

export type SignedPayload<T> = {
  payload: T;
  signature: string;
  publicKeyId: string;
  algorithm: typeof evidenceSignatureAlgorithm;
};

export function isSha256Hex(value: string) {
  return /^[a-f0-9]{64}$/i.test(value);
}

export function enrollmentChallengeMessage(challenge: string, sessionId: string) {
  return `authenti8-enrollment-v1\n${sessionId}\n${challenge}`;
}

export function telemetrySignatureMessage(event: TelemetrySignatureFields) {
  return ["authenti8-telemetry-v1", event.verificationSessionId, event.eventId,
    event.sequenceNumber, event.eventType, event.eventTimestamp, event.monotonicTimestamp,
    event.platform, event.agentVersion, event.rulePackVersion, event.payloadHash,
    event.previousEventHash ?? ""].join("\n");
}

export function telemetryChainMaterial(signatureMessage: string, signature: string) {
  return `${signatureMessage}\n${signature}`;
}

type TelemetrySignatureFields = {
  verificationSessionId: string;
  eventId: string;
  sequenceNumber: number;
  eventType: string;
  eventTimestamp: string;
  monotonicTimestamp: number;
  platform: string;
  agentVersion: string;
  rulePackVersion: string;
  payloadHash: string;
  previousEventHash?: string;
};
