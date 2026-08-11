import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveEnrollmentToken, hashPassword, hashToken, verifyPassword } from "./crypto.js";

test("passwords are salted and verifiable", async () => {
  const first = await hashPassword("Strong password!42");
  const second = await hashPassword("Strong password!42");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("Strong password!42", first), true);
  assert.equal(await verifyPassword("wrong", first), false);
});

test("tokens use deterministic SHA-256 hashes", () => {
  assert.equal(hashToken("token"), hashToken("token"));
  assert.notEqual(hashToken("token"), hashToken("other"));
});

test("enrollment credentials are deterministic and domain-separated", () => {
  const token = "candidate-secret";
  assert.equal(deriveEnrollmentToken(token), deriveEnrollmentToken(token));
  assert.notEqual(deriveEnrollmentToken(token), hashToken(token));
  assert.match(deriveEnrollmentToken(token), /^[a-f0-9]{64}$/);
});
