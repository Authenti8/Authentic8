import assert from "node:assert/strict";
import test from "node:test";
import { isTelemetryEnvelope } from "./index.js";

const validEnvelope = {
  schemaVersion: 1,
  eventId: "10000000-0000-4000-8000-000000000001",
  verificationSessionId: "20000000-0000-4000-8000-000000000001",
  sequenceNumber: 1,
  eventType: "HEARTBEAT",
  eventTimestamp: "2026-08-05T12:00:00.000Z",
  monotonicTimestamp: 100,
  platform: "WINDOWS",
  agentVersion: "0.1.0",
  rulePackVersion: "0.1.0",
  payload: {},
  payloadHash: "a".repeat(64),
  signature: "signed-value",
};

test("accepts a complete telemetry envelope", () => {
  assert.equal(isTelemetryEnvelope(validEnvelope), true);
});

test("rejects incomplete or malformed telemetry envelopes", () => {
  assert.equal(isTelemetryEnvelope({
    schemaVersion: 1,
    eventId: validEnvelope.eventId,
    verificationSessionId: validEnvelope.verificationSessionId,
    sequenceNumber: 1,
    signature: "signed-value",
  }), false);
  assert.equal(isTelemetryEnvelope({ ...validEnvelope, eventType: "UNKNOWN" }), false);
  assert.equal(isTelemetryEnvelope({ ...validEnvelope, sequenceNumber: -1 }), false);
  assert.equal(isTelemetryEnvelope({ ...validEnvelope, payloadHash: "not-a-hash" }), false);
  assert.equal(isTelemetryEnvelope({ ...validEnvelope, payload: [] }), false);
  assert.equal(isTelemetryEnvelope({
    ...validEnvelope,
    eventTimestamp: "2026-02-31T12:00:00Z",
  }), false);
  assert.equal(isTelemetryEnvelope({
    ...validEnvelope,
    eventTimestamp: "2026-08-05T12:00:00",
  }), false);
});

test("accepts calendar-valid RFC 3339 timestamps with explicit offsets", () => {
  assert.equal(isTelemetryEnvelope({
    ...validEnvelope,
    eventTimestamp: "2024-02-29T17:30:00.123456789+05:30",
  }), true);
  assert.equal(isTelemetryEnvelope({
    ...validEnvelope,
    eventTimestamp: "2025-02-29T17:30:00Z",
  }), false);
});
