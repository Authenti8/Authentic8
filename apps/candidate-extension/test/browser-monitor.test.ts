import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { changedExtension, hasRecentProfileProof, matchExtensions,
  validSignatures } from "../src/browser-monitor.js";
import { verifyChromeRulePack } from "../src/chrome-rule-pack.js";

test("only matched extension identifiers leave the profile", () => {
  const inventory = [
    { id: "a".repeat(32), version: "1.2.3", enabled: true, installType: "admin",
      name: "Sensitive name", permissions: ["tabs"] },
    { id: "b".repeat(32), version: "2", enabled: true, installType: "normal",
      name: "Legitimate extension", permissions: ["history"] },
  ];
  const signatures = { rulePackVersion: "chrome-7", rules: {
    ["a".repeat(32)]: { ruleKey: "known-tool", ruleVersion: 7 } } };
  const evidence = matchExtensions(inventory, signatures);
  assert.equal(evidence.length, 1);
  assert.deepEqual(evidence[0]?.payload, { extensionId: "a".repeat(32), version: "1.2.3",
    enabled: true, installationType: "ADMIN", ruleKey: "known-tool", ruleVersion: 7,
    rulePackVersion: "chrome-7" });
  assert.equal(JSON.stringify(evidence).includes("Sensitive name"), false);
  assert.equal(JSON.stringify(evidence).includes("history"), false);
});

test("signature configuration and changes are strictly filtered", () => {
  const signatures = { rulePackVersion: "chrome-2", rules: {
    ["a".repeat(32)]: { ruleKey: "rule-1", ruleVersion: 2 }, invalid: "rule-2" } };
  assert.deepEqual(validSignatures(signatures), { rulePackVersion: "chrome-2", rules: {
    ["a".repeat(32)]: { ruleKey: "rule-1", ruleVersion: 2 } } });
  assert.equal(changedExtension({ id: "b".repeat(32), version: "1", enabled: false,
    installType: "normal" }, validSignatures(signatures)), undefined);
});

test("periodic health retains a fresh active-profile proof without retaining stale proof", () => {
  const now = 1_000_000;
  assert.equal(hasRecentProfileProof(now - 5_000, now), true);
  assert.equal(hasRecentProfileProof(now - 15_001, now), false);
  assert.equal(hasRecentProfileProof(now + 1, now), false);
  assert.equal(hasRecentProfileProof(undefined, now), false);
});

test("signed Chrome packs become versioned extension signatures", async () => {
  const keys = generateKeyPairSync("ed25519");
  const unsigned = { version: "chrome-4", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    rules: [{ key: "known-tool", version: 4, enabled: true, extensionIds: ["a".repeat(32)] }] };
  const signature = sign(null, Buffer.from(canonicalJson(unsigned)), keys.privateKey)
    .toString("base64url");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const verified = await verifyChromeRulePack({ ...unsigned, signature }, publicKey);
  assert.deepEqual(verified, { rulePackVersion: "chrome-4", rules: {
    ["a".repeat(32)]: { ruleKey: "known-tool", ruleVersion: 4 } } });
  await assert.rejects(verifyChromeRulePack({ ...unsigned, signature: "invalid" }, publicKey));
  await assert.rejects(verifyChromeRulePack({ ...unsigned, signature, rules: [
    ...unsigned.rules, { ...unsigned.rules[0]!, key: "duplicate-tool" },
  ] }, publicKey), /duplicate extension ID/);
  await assert.rejects(verifyChromeRulePack({ ...unsigned, expiresAt: "invalid", signature },
    publicKey), /metadata is invalid/);
});

test("candidate extension declares the managed verification-key policy", () => {
  const root = new URL("../../", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
  const schema = JSON.parse(readFileSync(new URL("managed-policy-schema.json", root), "utf8"));
  assert.equal(manifest.storage.managed_schema, "managed-policy-schema.json");
  assert.equal(schema.properties.rulePackPublicKey.type, "string");
});

test("newly installed extensions are evaluated immediately", () => {
  const compiled = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
  assert.match(compiled, /management\.onInstalled\.addListener/);
  assert.match(compiled, /verifiedChromeRulePack/);
  assert.match(compiled, /verifyChromeRulePack/);
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(",")}}`;
}
