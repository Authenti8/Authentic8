import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function accuracyArtifact(body: Record<string, unknown>) {
  const payload = JSON.stringify(body);
  const digest = createHash("sha256").update(payload).digest("hex");
  return { digest, payload };
}

export function attestedAccuracyInput<T extends Record<string, unknown>>(body: T) {
  return { ...body, attestationDigest: accuracyArtifact(body).digest,
    attestationProvider: "HMAC_SHA256" };
}

export function validAccuracySignature(payload: string, signature: string | undefined,
  secret: string) {
  if (!signature?.startsWith("sha256=")) return false;
  const supplied = Buffer.from(signature.slice(7), "hex");
  const expected = createHmac("sha256", secret).update(payload).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
