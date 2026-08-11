import { generateKeyPairSync, sign } from "node:crypto";
import { hostname, release } from "node:os";
import { enrollmentChallengeMessage } from "@authenti8/security";
import { AgentHttpClient } from "./http-client.js";
import type { AgentConfiguration, EnrolledIdentity } from "./types.js";
import { loadIdentity, loadPendingEnrollment, saveIdentity,
  savePendingEnrollment } from "./credential-store.js";

export async function loadOrEnrollDevice(config: AgentConfiguration) {
  const stored = await loadIdentity(config.enrollmentToken);
  if (stored) return stored;
  const enrolled = await enrollDevice(config);
  await saveIdentity(config.enrollmentToken, enrolled);
  return enrolled;
}

export async function enrollDevice(config: AgentConfiguration): Promise<EnrolledIdentity> {
  const client = new AgentHttpClient(config.apiOrigin);
  const stored = await loadPendingEnrollment(config.enrollmentToken);
  if (stored) return completeEnrollment(client, config, stored);
  const challenge = await client.post<Challenge>("agent/enrollment/challenge", {
    token: config.enrollmentToken,
  });
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const message = enrollmentChallengeMessage(challenge.challenge, challenge.verificationSessionId);
  const challengeSignature = sign(null, Buffer.from(message), keys.privateKey).toString("base64url");
  const pending = { publicKey,
    privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    challengeSignature, challengeExpiresAt: challenge.expiresAt };
  await savePendingEnrollment(config.enrollmentToken, pending);
  return completeEnrollment(client, config, pending);
}

async function completeEnrollment(client: AgentHttpClient, config: AgentConfiguration,
  pending: { publicKey: string; privateKey: string; challengeSignature: string }) {
  const enrolled = await client.post<Enrollment>("agent/enrollment/complete", {
    token: config.enrollmentToken, publicKey: pending.publicKey,
    challengeSignature: pending.challengeSignature, platform: "WINDOWS",
    platformVersion: release(), agentVersion: config.agentVersion, deviceName: hostname(),
  });
  return { ...enrolled, privateKey: pending.privateKey };
}

type Challenge = { verificationSessionId: string; challenge: string; expiresAt: string };
type Enrollment = Omit<EnrolledIdentity, "privateKey">;
