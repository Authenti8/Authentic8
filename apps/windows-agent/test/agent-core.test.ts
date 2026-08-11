import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WindowsRulePack } from "@authenti8/detection-rules";
import { parseActivationUrl, validateConfiguration } from "../src/config.js";
import { matchSnapshot } from "../src/detection-matcher.js";
import { canonicalJson } from "../src/event-chain.js";
import { EventChain } from "../src/event-chain.js";
import { verifyRulePack } from "../src/rule-pack-verifier.js";
import { audioChanges, processChanges, windowChanges } from "../src/snapshot-diff.js";
import { checkForUpdate } from "../src/update-verifier.js";
import { recoverInterruptedUpdate } from "../src/update-recovery.js";
import { windowsSystemExecutable, windowsSystemRoot } from "../src/powershell.js";

test("Windows helpers honor and validate the configured system directory", () => {
  const environment = { SystemRoot: "D:\\WinNT" };
  assert.equal(windowsSystemRoot(environment), "D:\\WinNT");
  assert.equal(windowsSystemExecutable("tar.exe", environment), "D:\\WinNT\\System32\\tar.exe");
  assert.equal(windowsSystemExecutable("powershell.exe", environment),
    "D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.throws(() => windowsSystemRoot({ SystemRoot: "relative\\Windows" }));
});

test("activation accepts only the Authenti8 protocol and a strong token", () => {
  const token = "a".repeat(64);
  assert.equal(parseActivationUrl(`authenti8://verify?token=${token}`), token);
  assert.throws(() => parseActivationUrl(`https://verify?token=${token}`));
  assert.throws(() => parseActivationUrl("authenti8://verify?token=short"));
  assert.doesNotThrow(() => validateConfiguration({ apiOrigin: "https://api.authenti8.test",
    enrollmentToken: token, agentVersion: "1.0.0", rulePackVersion: "1" }));
  assert.throws(() => validateConfiguration({ apiOrigin: "http://remote.test",
    enrollmentToken: token, agentVersion: "1.0.0", rulePackVersion: "1" }));
});

test("snapshot diff emits changes and removals instead of complete lists", () => {
  const process = { processId: 2, executableName: "tool.exe", change: "STARTED" as const };
  assert.equal(processChanges([process], [process]).length, 0);
  assert.equal(processChanges([process], [])[0]?.change, "STOPPED");
  const window = { windowIdHash: "a", ownerProcessId: 2, visible: true, topmost: false,
    layered: false, transparent: false, captureExcluded: false, titleHash: "b", classHash: "c",
    bounds: { left: 0, top: 0, width: 1, height: 1 } };
  assert.equal(windowChanges([window], [window]).length, 0);
  const audio = { endpointIdHash: "a", friendlyName: "Mic", direction: "CAPTURE" as const,
    state: "ACTIVE" as const, isDefaultCommunications: false, change: "BASELINE" as const };
  assert.equal(audioChanges([], [audio], true)[0]?.change, "BASELINE");
  assert.equal(audioChanges([audio], [])[0]?.change, "REMOVED");
});

test("a suspicious name alone remains low confidence", () => {
  const pack = unsignedPack();
  const snapshot = { processes: [{ processId: 7, executableName: "fixture.exe",
    productName: "fixture.exe", change: "STARTED" as const }],
    windows: [], audioEndpoints: [] };
  assert.equal(matchSnapshot(snapshot, pack)[0]?.confidence, "LOW");
});

test("confirmation requires authoritative identity and independent active-use evidence", () => {
  const pack = unsignedPack();
  const snapshot = { processes: [{ processId: 7, executableName: "fixture.exe",
    executableSha256: "1".repeat(64), productName: "fixture.exe", change: "STARTED" as const }],
    windows: [{ windowIdHash: "w", ownerProcessId: 7, visible: true, topmost: true,
      layered: false, transparent: false, captureExcluded: false, titleHash: "t", classHash: "c",
      bounds: { left: 0, top: 0, width: 20, height: 20 } }], audioEndpoints: [] };
  assert.equal(matchSnapshot(snapshot, pack)[0]?.confidence, "HIGH");
});

test("overlay-required rules cannot be confirmed by audio evidence alone", () => {
  const base = unsignedPack();
  const pack = { ...base, rules: [{ ...base.rules[0]!, virtualAudioNames: ["Fixture Audio"] }] };
  const snapshot = { processes: [{ processId: 7, executableName: "fixture.exe",
    executableSha256: "1".repeat(64), change: "STARTED" as const }], windows: [],
  audioEndpoints: [{ endpointIdHash: "audio", friendlyName: "Fixture Audio",
    direction: "CAPTURE" as const, state: "ACTIVE" as const,
    isDefaultCommunications: true, change: "BASELINE" as const }] };
  assert.equal(matchSnapshot(snapshot, pack)[0]?.confidence, "LOW");
});

test("valid signer and Windows product metadata can establish process identity", () => {
  const base = unsignedPack();
  const pack = { ...base, rules: [{ ...base.rules[0]!, executableSha256: [],
    signerThumbprints: ["a".repeat(40)], productNames: ["Fixture Product"] }] };
  const snapshot = { processes: [{ processId: 7, executableName: "renamed.exe",
    productName: "Fixture Product", signerThumbprint: "a".repeat(40), change: "STARTED" as const }],
  windows: [{ windowIdHash: "w", ownerProcessId: 7, visible: true, topmost: true,
    layered: false, transparent: false, captureExcluded: false, titleHash: "t", classHash: "c",
    bounds: { left: 0, top: 0, width: 20, height: 20 } }], audioEndpoints: [] };
  assert.equal(matchSnapshot(snapshot, pack)[0]?.confidence, "HIGH");
});

test("rule packs require a valid Ed25519 signature and expiry", () => {
  const keys = generateKeyPairSync("ed25519");
  const pack = unsignedPack(); const { signature: ignored, ...unsigned } = pack;
  void ignored;
  const signature = sign(null, Buffer.from(canonicalJson(unsigned)), keys.privateKey).toString("base64url");
  const signed = { ...pack, signature };
  const key = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  assert.equal(verifyRulePack(signed, key), signed);
  assert.throws(() => verifyRulePack({ ...signed, version: "changed" }, key));
  assert.throws(() => verifyRulePack({ ...signed,
    rules: [{ ...signed.rules[0]!, executableSha256: ["not-a-hash"] }] }, key));
});

test("event chains resume from their persisted acknowledged position", () => {
  const keys = generateKeyPairSync("ed25519");
  const context = { sessionId: randomUUID(),
    privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    agentVersion: "1.0.0", rulePackVersion: "1" };
  const first = new EventChain(context);
  const started = first.create("MONITORING_STARTED", {});
  const resumed = new EventChain(context, first.state());
  const heartbeat = resumed.create("HEARTBEAT", {});
  assert.equal(heartbeat.sequenceNumber, 1);
  assert.ok(heartbeat.previousEventHash);
  assert.notEqual(heartbeat.previousEventHash, started.previousEventHash);
});

test("an agent below the minimum version downloads a compliant signed update", async () => {
  const keys = generateKeyPairSync("ed25519");
  const bytes = Buffer.from("signed update fixture");
  const unsigned = { version: "2.1.0", minimumVersion: "2.0.0",
    downloadUrl: "https://downloads.authenti8.test/Authenti8Verify.zip",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    publishedAt: new Date().toISOString() };
  const manifest = { ...unsigned, signature: sign(null,
    Buffer.from(canonicalJson(unsigned)), keys.privateKey).toString("base64url") };
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) =>
    String(input).includes("manifest")
      ? new Response(JSON.stringify(manifest), { status: 200 })
      : new Response(bytes, { status: 200 })) as typeof fetch;
  try {
    const update = await checkForUpdate(new URL("https://api.authenti8.test/manifest"),
      "1.0.0", publicKey);
    assert.equal(update?.manifest.version, "2.1.0");
    assert.deepEqual(Buffer.from(update!.bytes), bytes);
    const prereleaseUpdate = await checkForUpdate(new URL("https://api.authenti8.test/manifest"),
      "2.1.0-beta.1", publicKey);
    assert.equal(prereleaseUpdate?.manifest.version, "2.1.0");
  } finally { globalThis.fetch = originalFetch; }
});

test("startup rolls back an interrupted asset replacement", () => {
  const directory = mkdtempSync(join(tmpdir(), "authenti8-recovery-test-"));
  const executable = join(directory, "Authenti8Verify.exe");
  const backup = join(directory, ".update-backup-test");
  const staging = mkdtempSync(join(tmpdir(), "Authenti8-Update-test-"));
  const packagePath = join(tmpdir(), `Authenti8Verify-test-${randomUUID()}.zip`);
  try {
    writeFileSync(executable, "old executable");
    mkdirSync(join(directory, "native")); writeFileSync(join(directory, "native", "marker"), "new");
    mkdirSync(join(backup, "native"), { recursive: true });
    writeFileSync(join(backup, "native", "marker"), "old"); writeFileSync(packagePath, "package");
    writeFileSync(join(directory, ".update-journal.json"), JSON.stringify({
      phase: "assets_replaced", backup, staging, packagePath,
      newExecutableSha256: "1".repeat(64),
    }));
    recoverInterruptedUpdate(executable);
    assert.equal(readFileSync(join(directory, "native", "marker"), "utf8"), "old");
    assert.equal(readFileSync(executable, "utf8"), "old executable");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true }); rmSync(packagePath, { force: true });
  }
});

test("rollback removes a native host that was absent before the update", () => {
  const directory = mkdtempSync(join(tmpdir(), "authenti8-recovery-host-test-"));
  const executable = join(directory, "Authenti8Verify.exe");
  const backup = join(directory, ".update-backup-test");
  const staging = mkdtempSync(join(tmpdir(), "Authenti8-Update-host-test-"));
  const packagePath = join(tmpdir(), `Authenti8Verify-host-test-${randomUUID()}.zip`);
  try {
    writeFileSync(executable, "old executable"); mkdirSync(backup);
    writeFileSync(join(directory, "Authenti8VerifyNativeHost.exe"), "new host");
    writeFileSync(packagePath, "package");
    writeFileSync(join(directory, ".update-journal.json"), JSON.stringify({
      phase: "commit_executable", backup, staging, packagePath,
      newExecutableSha256: "1".repeat(64),
    }));
    recoverInterruptedUpdate(executable);
    assert.equal(existsSync(join(directory, "Authenti8VerifyNativeHost.exe")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true }); rmSync(packagePath, { force: true });
  }
});

function unsignedPack(): WindowsRulePack {
  return { version: "test", expiresAt: new Date(Date.now() + 60_000).toISOString(), signature: "test",
    rules: [{ key: "fixture", family: "TEST_ONLY", version: 1, enabled: true,
      executableSha256: ["1".repeat(64)], signerThumbprints: [], productNames: ["fixture.exe"],
      overlayRequired: true }] };
}
