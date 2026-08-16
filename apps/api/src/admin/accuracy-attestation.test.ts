import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { accuracyArtifact, attestedAccuracyInput, validAccuracySignature } from
  "./accuracy-attestation.js";

test("accuracy attestations bind the exact uploaded artifact", () => {
  const secret = "dedicated-accuracy-upload-secret";
  const artifact = accuracyArtifact({ platform: "WINDOWS", scenarios: [{ actual: "CONFIRMED" }] });
  const signature = createHmac("sha256", secret).update(artifact.payload).digest("hex");
  assert.equal(validAccuracySignature(artifact.payload, `sha256=${signature}`, secret), true);
  assert.equal(validAccuracySignature(`${artifact.payload} `, `sha256=${signature}`, secret), false);
  assert.match(artifact.digest, /^[0-9a-f]{64}$/);
});

test("accuracy RPC input preserves the tested binary digest", () => {
  const artifactDigest = "a".repeat(64);
  const input = attestedAccuracyInput({ artifactDigest, evidenceSource: "NATIVE_E2E" });
  assert.equal(input.artifactDigest, artifactDigest);
  assert.match(input.attestationDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(input.attestationDigest, artifactDigest);
});

test("accuracy attestations reject malformed signatures", () => {
  assert.equal(validAccuracySignature("{}", "sha256=not-hex", "secret"), false);
  assert.equal(validAccuracySignature("{}", undefined, "secret"), false);
});
