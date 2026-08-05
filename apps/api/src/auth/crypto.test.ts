import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, hashToken, verifyPassword } from "./crypto.js";

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
