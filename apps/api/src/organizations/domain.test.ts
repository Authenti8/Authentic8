import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidTimezone, normalizeDomain } from "./domain.js";

test("organization domains are normalized", () => {
  assert.equal(normalizeDomain("https://www.Example.com/team"), "example.com");
  assert.equal(normalizeDomain("not a domain"), null);
  assert.equal(normalizeDomain("localhost"), null);
});

test("timezones are validated by the runtime", () => {
  assert.equal(isValidTimezone("Asia/Kolkata"), true);
  assert.equal(isValidTimezone("Mars/Olympus"), false);
});
