import { createHash, createPublicKey, verify } from "node:crypto";
import { telemetryChainMaterial, telemetrySignatureMessage } from "@authenti8/security";
import type { TelemetryEnvelope } from "@authenti8/event-schemas";

export function verifyTelemetry(event: TelemetryEnvelope, publicKey: string) {
  const payloadHash = sha256(canonicalJson(event.payload));
  if (payloadHash !== event.payloadHash.toLowerCase()) return undefined;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"),
      format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return undefined;
    const message = telemetrySignatureMessage(event);
    if (!verify(null, Buffer.from(message), key, Buffer.from(event.signature, "base64url"))) {
      return undefined;
    }
    return sha256(telemetryChainMaterial(message, event.signature));
  } catch {
    return undefined;
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
