import { createHash, createPublicKey, verify } from "node:crypto";
import { enrollmentChallengeMessage } from "@authenti8/security";

const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

export function verifyEnrollmentSignature(input: EnrollmentProof) {
  try {
    const publicKeyBytes = decodeBase64Url(input.publicKey, 44, 64);
    const signature = decodeBase64Url(input.signature, 64, 64);
    const key = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return false;
    const message = enrollmentChallengeMessage(input.challenge, input.sessionId);
    return verify(null, Buffer.from(message, "utf8"), key, signature);
  } catch {
    return false;
  }
}

export function publicKeyFingerprint(publicKey: string) {
  const bytes = decodeBase64Url(publicKey, 44, 64);
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeBase64Url(value: string, minimum: number, maximum: number) {
  if (!base64UrlPattern.test(value) || value.length > 128) throw new Error("invalid encoding");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < minimum || bytes.length > maximum) throw new Error("invalid length");
  return bytes;
}

type EnrollmentProof = {
  publicKey: string;
  signature: string;
  challenge: string;
  sessionId: string;
};
