import assert from "node:assert/strict";
import test from "node:test";
import { assertActiveGoogleAccount, parseGoogleProfile } from "./auth.service.js";

test("Google profiles require verified identity claims", () => {
  assert.throws(() => parseGoogleProfile(null));
  assert.throws(() => parseGoogleProfile({ sub: "subject", email: "invalid" }));
  assert.throws(() => parseGoogleProfile({
    sub: "subject",
    email: "person@example.com",
    email_verified: "true",
  }));
});

test("Google profiles use a safe fallback when name is absent", () => {
  const profile = parseGoogleProfile({
    sub: "subject",
    email: "Person@Example.com",
    email_verified: true,
  });
  assert.equal(profile.email, "person@example.com");
  assert.equal(profile.name, "Person");
});

test("Google login rejects non-active accounts", () => {
  assert.doesNotThrow(() => assertActiveGoogleAccount("ACTIVE"));
  assert.throws(() => assertActiveGoogleAccount("SUSPENDED"));
  assert.throws(() => assertActiveGoogleAccount("DELETED"));
});
