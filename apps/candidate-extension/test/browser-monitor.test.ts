import assert from "node:assert/strict";
import test from "node:test";
import { changedExtension, hasRecentProfileProof, matchExtensions,
  validSignatures } from "../src/browser-monitor.js";

test("only matched extension identifiers leave the profile", () => {
  const inventory = [
    { id: "a".repeat(32), version: "1.2.3", enabled: true, installType: "admin",
      name: "Sensitive name", permissions: ["tabs"] },
    { id: "b".repeat(32), version: "2", enabled: true, installType: "normal",
      name: "Legitimate extension", permissions: ["history"] },
  ];
  const evidence = matchExtensions(inventory, { ["a".repeat(32)]: "known-tool" });
  assert.equal(evidence.length, 1);
  assert.deepEqual(evidence[0]?.payload, { extensionId: "a".repeat(32), version: "1.2.3",
    enabled: true, installationType: "ADMIN", ruleKey: "known-tool" });
  assert.equal(JSON.stringify(evidence).includes("Sensitive name"), false);
  assert.equal(JSON.stringify(evidence).includes("history"), false);
});

test("signature configuration and changes are strictly filtered", () => {
  assert.deepEqual(validSignatures({ ["a".repeat(32)]: "rule-1", invalid: "rule-2" }),
    { ["a".repeat(32)]: "rule-1" });
  assert.equal(changedExtension({ id: "b".repeat(32), version: "1", enabled: false,
    installType: "normal" }, { ["a".repeat(32)]: "rule-1" }), undefined);
});

test("periodic health retains a fresh active-profile proof without retaining stale proof", () => {
  const now = 1_000_000;
  assert.equal(hasRecentProfileProof(now - 5_000, now), true);
  assert.equal(hasRecentProfileProof(now - 15_001, now), false);
  assert.equal(hasRecentProfileProof(now + 1, now), false);
  assert.equal(hasRecentProfileProof(undefined, now), false);
});
