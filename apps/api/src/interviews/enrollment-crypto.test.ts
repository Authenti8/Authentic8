import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { enrollmentChallengeMessage } from "@authenti8/security";
import { publicKeyFingerprint, verifyEnrollmentSignature } from "./enrollment-crypto.js";

test("enrollment proof binds the key to both challenge and session", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const challenge = "challenge";
  const sessionId = "96668a46-20cd-4a59-92e6-7c84e1f523a3";
  const message = enrollmentChallengeMessage(challenge, sessionId);
  const signature = sign(null, Buffer.from(message), keys.privateKey).toString("base64url");
  assert.equal(verifyEnrollmentSignature({ publicKey, signature, challenge, sessionId }), true);
  assert.equal(verifyEnrollmentSignature({ publicKey, signature, challenge: "changed", sessionId }), false);
  assert.match(publicKeyFingerprint(publicKey), /^[a-f0-9]{64}$/);
});

test("enrollment rejects malformed and non-Ed25519 keys", () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  assert.equal(verifyEnrollmentSignature({ publicKey, signature: "invalid", challenge: "x",
    sessionId: "96668a46-20cd-4a59-92e6-7c84e1f523a3" }), false);
});
