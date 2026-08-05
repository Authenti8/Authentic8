import assert from "node:assert/strict";
import test from "node:test";
import { safeAuthReturnPath } from "./auth.controller.js";

test("OAuth return paths allow only protected application routes", () => {
  assert.equal(safeAuthReturnPath("/dashboard/meetings"), "/dashboard/meetings");
  assert.equal(safeAuthReturnPath("/onboarding"), "/onboarding");
  assert.equal(safeAuthReturnPath("//attacker.example"), undefined);
  assert.equal(safeAuthReturnPath("/dashboard-attack"), undefined);
  assert.equal(safeAuthReturnPath("https://attacker.example"), undefined);
});
