import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";
import { telemetrySignatureMessage } from "@authenti8/security";
import { telemetrySchemaVersion, type TelemetryEnvelope } from "@authenti8/event-schemas";
import { canonicalJson, verifyTelemetry } from "./telemetry-crypto.js";

test("telemetry verification covers canonical payload, sequence, and chain", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const payload = { z: true, nested: { b: 2, a: 1 } };
  const payloadHash = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  const unsigned = eventWith({ payload, payloadHash, signature: "pending" });
  const message = telemetrySignatureMessage(unsigned);
  const signature = sign(null, Buffer.from(message), keys.privateKey).toString("base64url");
  const event = { ...unsigned, signature };
  assert.match(verifyTelemetry(event, publicKey) ?? "", /^[a-f0-9]{64}$/);
  assert.equal(verifyTelemetry({ ...event, sequenceNumber: 1 }, publicKey), undefined);
  assert.equal(verifyTelemetry({ ...event, payload: { changed: true } }, publicKey), undefined);
});

function eventWith(values: Pick<TelemetryEnvelope, "payload" | "payloadHash" | "signature">) {
  return { schemaVersion: telemetrySchemaVersion, eventId: randomUUID(),
    verificationSessionId: randomUUID(), sequenceNumber: 0, eventType: "HEARTBEAT",
    eventTimestamp: new Date().toISOString(), monotonicTimestamp: 0, platform: "WINDOWS",
    agentVersion: "0.1.0", rulePackVersion: "test", ...values } satisfies TelemetryEnvelope;
}
