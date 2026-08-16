import assert from "node:assert/strict";
import test from "node:test";
import { requiresAccuracyReleaseGate } from "./admin.controller.js";

test("production agents can only be promoted through the signed accuracy release gate", () => {
  assert.equal(requiresAccuracyReleaseGate({
    application: "WINDOWS_AGENT", releaseChannel: "PRODUCTION",
  }), true);
  assert.equal(requiresAccuracyReleaseGate({
    application: "MACOS_AGENT", releaseChannel: "PRODUCTION",
  }), true);
  assert.equal(requiresAccuracyReleaseGate({
    application: "WINDOWS_AGENT", releaseChannel: "STAGING",
  }), false);
  assert.equal(requiresAccuracyReleaseGate({
    application: "RECRUITER_EXTENSION", releaseChannel: "PRODUCTION",
  }), false);
});
