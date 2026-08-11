export type EnrollmentChallengeResult = {
  valid: boolean;
  reason?: string;
  verificationSessionId?: string;
  challenge?: string;
  expiresAt?: string;
};

export type DeviceEnrollmentInput = {
  token: string;
  publicKey: string;
  challengeSignature: string;
  platform: "WINDOWS" | "MACOS";
  platformVersion: string;
  agentVersion: string;
  deviceName?: string;
};
