import assert from "node:assert/strict";
import test from "node:test";
import { decryptMailToken, encryptMailToken } from "./mail-crypto.js";

test("email outbox tokens are encrypted and context-bound", () => {
  const key = Buffer.alloc(32, 9);
  const encrypted = encryptMailToken(key, "secret-token", "reset:user@example.com");
  assert.notEqual(encrypted.ciphertext, "secret-token");
  assert.equal(
    decryptMailToken(key, encrypted, "reset:user@example.com"),
    "secret-token",
  );
  assert.throws(() => decryptMailToken(key, encrypted, "verify:user@example.com"));
});
