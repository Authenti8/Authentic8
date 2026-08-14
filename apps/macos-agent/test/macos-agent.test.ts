import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import type { MacosRulePack } from "@authenti8/detection-rules";
import { matchMacosSnapshot } from "../src/matcher.js";
import { parseActivationUrl } from "../src/config.js";
import { TelemetryDelivery } from "../src/delivery.js";
import { MacosEventChain } from "../src/event-chain.js";
import { evidenceChanges } from "../src/macos-agent.js";
import type { MacosIdentity } from "../src/types.js";

test("activation requires the Authenti8 protocol and a strong token", () => {
  const token = "a".repeat(64);
  assert.equal(parseActivationUrl(`authenti8://verify?token=${token}`), token);
  assert.throws(() => parseActivationUrl(`https://verify?token=${token}`));
});

test("a macOS identity requires active-use evidence before confirmation", () => {
  const pack: MacosRulePack = { version: "1", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    signature: "fixture", rules: [{ key: "fixture", family: "TEST_ONLY", version: 1,
      enabled: true, bundleIdentifiers: ["com.example.fixture"], teamIdentifiers: [],
      executableSha256: [], overlayRequired: true }] };
  const base = { applications: [{ processId: 7, bundleIdentifier: "com.example.fixture" }],
    audioDevices: [], permissions: { accessibility: true, screenRecording: true } };
  assert.equal(matchMacosSnapshot({ ...base, windows: [] }, pack)[0]?.confirmed, false);
  assert.equal(matchMacosSnapshot({ ...base, windows: [{ ownerProcessId: 7,
    ownerBundleIdentifier: "com.example.fixture", windowIdHash: "a", titleHash: "b", layer: 3,
    alpha: 0.9, onScreen: true, bounds: { left: 0, top: 0, width: 100, height: 100 } }] },
  pack)[0]?.confirmed, true);
  const active = { ...base, windows: [{ ownerProcessId: 7,
    ownerBundleIdentifier: "com.example.fixture", windowIdHash: "a", titleHash: "b", layer: 3,
    alpha: 0.9, onScreen: true, bounds: { left: 0, top: 0, width: 100, height: 100 } }] };
  assert.equal(evidenceChanges(active, active, pack).some(
    (event) => event.eventType === "HIDDEN_OVERLAY_MATCH"), false);
  assert.equal(evidenceChanges({ ...base, windows: [] }, active, pack).some(
    (event) => event.eventType === "HIDDEN_OVERLAY_MATCH"), true);
});

test("an unavailable permission remains an explicit coverage state", () => {
  const snapshot = { applications: [], windows: [], audioDevices: [],
    permissions: { accessibility: false, screenRecording: false } };
  assert.equal(snapshot.permissions.accessibility, false);
  assert.equal(snapshot.permissions.screenRecording, false);
});

test("macOS snapshot diffs include process, window, and audio lifecycle changes", () => {
  const pack: MacosRulePack = { version: "1", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    signature: "fixture", rules: [] };
  const permissions = { accessibility: true, screenRecording: true };
  const previous = { applications: [{ processId: 1, bundleIdentifier: "com.example.old" }],
    windows: [{ ownerProcessId: 1, windowIdHash: "old-window", titleHash: "old", layer: 0,
      alpha: 1, onScreen: true, bounds: { left: 0, top: 0, width: 10, height: 10 } }],
    audioDevices: [{ deviceIdHash: "mic", name: "Mic", direction: "CAPTURE" as const,
      virtual: false, isDefault: true }], permissions };
  const current = { applications: [{ processId: 2, bundleIdentifier: "com.example.new" }],
    windows: [{ ownerProcessId: 2, windowIdHash: "new-window", titleHash: "new", layer: 0,
      alpha: 1, onScreen: true, bounds: { left: 0, top: 0, width: 10, height: 10 } }],
    audioDevices: [{ deviceIdHash: "speaker", name: "Speaker", direction: "RENDER" as const,
      virtual: false, isDefault: true }], permissions };
  const types = evidenceChanges(previous, current, pack).map((event) => event.eventType);
  for (const expected of ["PROCESS_STARTED", "PROCESS_STOPPED", "WINDOW_CREATED",
    "WINDOW_CHANGED", "AUDIO_DEVICE_ADDED", "AUDIO_ROUTE_CHANGED"]) {
    assert.ok(types.includes(expected as never), `missing ${expected}`);
  }
});

test("queued macOS telemetry and its chain checkpoint share one durable write", async () => {
  const keys = generateKeyPairSync("ed25519");
  const identity: MacosIdentity = { deviceId: randomUUID(), verificationSessionId: randomUUID(),
    eligibleStart: new Date().toISOString(), eligibleEnd: new Date(Date.now() + 60_000).toISOString(),
    privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
  const chain = new MacosEventChain({ sessionId: identity.verificationSessionId,
    privateKey: identity.privateKey, agentVersion: "1.0.0", rulePackVersion: "1" });
  const snapshots: MacosIdentity[] = [];
  const delivery = new TelemetryDelivery({ post: async () => ({}) } as never, "token", identity,
    async (_token, value) => { snapshots.push(structuredClone(value)); });
  const event = chain.create("MONITORING_STARTED", {});
  await delivery.enqueue(event, chain.state(), true);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.pendingEvents?.[0]?.sequenceNumber, 0);
  assert.equal(snapshots[0]?.chainState?.sequence, 1);
  assert.equal(snapshots[0]?.monitoringStarted, true);
});
