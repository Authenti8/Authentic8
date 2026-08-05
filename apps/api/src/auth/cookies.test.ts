import assert from "node:assert/strict";
import test from "node:test";
import { readCookie } from "./cookies.js";

test("cookies decode valid values", () => {
  assert.equal(readCookie("other=1; session=hello%20world", "session"), "hello world");
});

test("malformed encoded cookies are treated as absent", () => {
  assert.doesNotThrow(() => readCookie("session=%ZZ", "session"));
  assert.equal(readCookie("session=%ZZ", "session"), undefined);
});
