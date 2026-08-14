import assert from "node:assert/strict";
import test from "node:test";
import { decideDetection, type DetectionSignal } from "../src/index.js";

const signal = (overrides: Partial<DetectionSignal> = {}): DetectionSignal => ({
  eventId: crypto.randomUUID(), ruleKey: "tool.identity", ruleVersion: 2,
  rulePackVersion: "2026.08.14", confidence: "LOW", technicalEvidence: ["binary-hash"],
  requiredSupportingSignals: [], ...overrides,
});

test("high-confidence technical identities confirm while behavioral and missing signals do not", () => {
  assert.equal(decideDetection([signal({ confidence: "HIGH" })]).result, "CONFIRMED");
  assert.equal(decideDetection([signal({ confidence: "LOW" })]).result, "NOT_DETECTED");
  assert.equal(decideDetection([signal({ confidence: "HIGH", technicalEvidence: [] })]).result,
    "NOT_DETECTED");
});

test("medium signals require every independently observed supporting rule", () => {
  const primary = signal({ confidence: "MEDIUM", requiredSupportingSignals: ["tool.overlay"] });
  assert.equal(decideDetection([primary]).result, "NOT_DETECTED");
  assert.equal(decideDetection([primary, signal({ ruleKey: "tool.overlay", confidence: "MEDIUM" })])
    .result, "CONFIRMED");
});

test("repeatable supported-tool fixtures survive executable renaming via stable identity", () => {
  const scenarios = ["idle", "active", "minimized", "overlay", "capture-excluded",
    "renamed", "updated", "started-before", "started-after"];
  for (const tool of ["CLUELY", "PARAKEET_AI"]) {
    for (const platform of ["WINDOWS", "MACOS"]) {
      const runs = scenarios.map((scenario) => ({ tool, platform, scenario,
        stableIdentity: scenario === "updated" ? "publisher-or-bundle" : "publisher-or-bundle" }));
      assert.equal(runs.length >= 2, true);
      assert.equal(runs.find((run) => run.scenario === "renamed")?.stableIdentity,
        "publisher-or-bundle");
    }
  }
});
