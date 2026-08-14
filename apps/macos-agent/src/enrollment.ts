import { generateKeyPairSync, sign } from "node:crypto";
import { hostname, release } from "node:os";
import { enrollmentChallengeMessage } from "@authenti8/security";
import { AgentHttpClient } from "./http-client.js";
import { loadIdentity, saveIdentity } from "./keychain.js";
import type { MacosAgentConfiguration, MacosIdentity } from "./types.js";

export async function loadOrEnroll(config: MacosAgentConfiguration) {
  const stored = await loadIdentity(config.enrollmentToken);
  if (stored) return stored;
  const client = new AgentHttpClient(config.apiOrigin);
  const challenge = await client.post<Challenge>("agent/enrollment/challenge",
    { token: config.enrollmentToken });
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const signature = sign(null, Buffer.from(enrollmentChallengeMessage(
    challenge.challenge, challenge.verificationSessionId)), keys.privateKey).toString("base64url");
  const enrolled = await client.post<Omit<MacosIdentity, "privateKey">>("agent/enrollment/complete", {
    token: config.enrollmentToken, publicKey, challengeSignature: signature, platform: "MACOS",
    platformVersion: release(), agentVersion: config.agentVersion, deviceName: hostname(),
  });
  const identity = { ...enrolled,
    privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
  await saveIdentity(config.enrollmentToken, identity);
  return identity;
}

type Challenge = { verificationSessionId: string; challenge: string; expiresAt: string };
