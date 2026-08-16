import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const fixtureMode = process.env.AUTHENTI8_ACCURACY_FIXTURE_MODE === "true";
const targetPlatform = selectedPlatform();
if (targetPlatform && !["WINDOWS", "MACOS"].includes(targetPlatform)) {
  throw new Error(`Unsupported accuracy platform: ${targetPlatform}.`);
}
let windowsPack;
let windowsMatcher;
let browserMatcher;
let macosPack;
let macosMatcher;
mkdirSync(resolve("accuracy-runner-results"), { recursive: true });
if (!targetPlatform || targetPlatform === "WINDOWS") {
  assertNativePlatform("WINDOWS", "win32");
  await prepareWindows();
}
if (!targetPlatform || targetPlatform === "MACOS") {
  assertNativePlatform("MACOS", "darwin");
  await prepareMacos();
}

async function prepareWindows() {
  const manifest = JSON.parse(readFileSync(resolve("test/accuracy/windows.json"), "utf8"));
  windowsPack = loadPack("ACCURACY_WINDOWS_RULE_PACK_PATH",
    "test/accuracy/windows-rule-pack.json", manifest.rulePackVersion);
  windowsMatcher = await import(pathToFileURL(resolve(
    "apps/windows-agent/dist/detection-matcher.js")).href);
  const verifier = await import(pathToFileURL(resolve(
    "apps/windows-agent/dist/rule-pack-verifier.js")).href);
  browserMatcher = await import(pathToFileURL(resolve(
    "apps/windows-agent/dist/browser-evidence-spool.js")).href);
  verifier.verifyRulePack(windowsPack, rulePackKey());
  write("windows.json", run(manifest,
    packageVersion("apps/windows-agent/package.json"), runWindows));
}

async function prepareMacos() {
  const manifest = JSON.parse(readFileSync(resolve("test/accuracy/macos.json"), "utf8"));
  macosPack = loadPack("ACCURACY_MACOS_RULE_PACK_PATH",
    "test/accuracy/macos-rule-pack.json", manifest.rulePackVersion);
  macosMatcher = await import(pathToFileURL(resolve("apps/macos-agent/dist/matcher.js")).href);
  const verifier = await import(pathToFileURL(resolve("apps/macos-agent/dist/rule-pack.js")).href);
  verifier.verifyMacosRulePack(macosPack, rulePackKey());
  write("macos.json", run(manifest,
    packageVersion("apps/macos-agent/package.json"), runMacos));
}

function rulePackKey() {
  return requiredReleaseValue("AUTHENTI8_RULE_PACK_PUBLIC_KEY",
    "test/accuracy/rule-pack-public-key.txt");
}

function run(manifest, agentVersion, execute) {
  if (manifest.agentVersion !== agentVersion) {
    throw new Error(`${manifest.platform} manifest targets ${manifest.agentVersion}, `
      + `but the built agent is ${agentVersion}.`);
  }
  const scenarios = manifest.scenarios.map((scenario, index) => ({ ...scenario,
    ...execute(scenario, index + 1) }));
  return { ...manifest, agentVersion, commitSha: process.env.GITHUB_SHA ?? manifest.commitSha,
    generatedBy: "authenti8-agent-matcher", evidenceSource: "MATCHER_FIXTURE",
    generatedAt: new Date().toISOString(), scenarios };
}

function packageVersion(path) {
  const version = JSON.parse(readFileSync(resolve(path), "utf8")).version;
  if (typeof version !== "string" || !version.trim()) throw new Error(`${path} has no version.`);
  return version;
}

function selectedPlatform() {
  const flag = process.argv.indexOf("--platform");
  if (flag >= 0 && !process.argv[flag + 1]) throw new Error("--platform requires a value.");
  const cli = flag >= 0 ? process.argv[flag + 1] : undefined;
  return (cli ?? process.env.AUTHENTI8_ACCURACY_PLATFORM)?.toUpperCase();
}

function assertNativePlatform(platform, expected) {
  if (!fixtureMode && process.platform !== expected) {
    throw new Error(`${platform} release accuracy must run on ${expected}, not ${process.platform}.`);
  }
}

function runWindows(scenario, processId) {
  const fixture = windowsFixture(scenario);
  const rule = windowsPack.rules.find((item) => item.key === fixture.ruleKey);
  if (!rule) throw new Error(`Scenario ${scenario.id} references an unknown Windows rule.`);
  if (fixture.channel === "EXTENSION") return browserResult(scenario, fixture, rule);
  const snapshot = { processes: [{ processId, executableName: `${scenario.id}.exe`,
    executableSha256: fixture.observedIdentity, change: "STARTED" }], windows:
  ["OVERLAY", "CAPTURE_EXCLUDED"].includes(fixture.channel) ? [{
    windowIdHash: `window-${processId}`, ownerProcessId: processId,
    visible: true, topmost: fixture.channel === "OVERLAY", layered: false, transparent: false,
    captureExcluded: fixture.channel === "CAPTURE_EXCLUDED",
    titleHash: "redacted", classHash: "redacted",
    bounds: { left: 0, top: 0, width: 100, height: 100 } }] : [],
  audioEndpoints: fixture.channel === "AUDIO" ? [{ endpointIdHash: `audio-${processId}`,
    friendlyName: fixture.audioName, dataFlow: "RENDER", state: "ACTIVE",
    isDefault: true, endpointVolume: 1 }] : [] };
  const actual = windowsMatcher.matchSnapshot(snapshot, windowsPack).some(
    (match) => match.confidence === "HIGH") ? "CONFIRMED" : "NOT_DETECTED";
  return { actual, coverageHealthy: Array.isArray(snapshot.processes)
    && Array.isArray(snapshot.windows) && Array.isArray(snapshot.audioEndpoints) };
}

function runMacos(scenario, processId) {
  const fixture = macosFixture(scenario);
  if (!macosPack.rules.some((item) => item.key === fixture.ruleKey)) {
    throw new Error(`Scenario ${scenario.id} references an unknown macOS rule.`);
  }
  const snapshot = { applications: [{ processId,
    bundleIdentifier: fixture.observedIdentity }],
  windows: fixture.channel === "OVERLAY" ? [{ ownerProcessId: processId,
    ownerBundleIdentifier: fixture.observedIdentity,
    windowIdHash: `window-${processId}`, titleHash: "redacted", layer: 3, alpha: 0.9,
    onScreen: true, bounds: { left: 0, top: 0, width: 100, height: 100 } }] : [],
  audioDevices: fixture.channel === "AUDIO" ? [{ deviceIdHash: `audio-${processId}`,
    name: fixture.audioName, direction: "CAPTURE", virtual: true, isDefault: true }] : [],
  permissions: { accessibility: true, screenRecording: true } };
  const actual = macosMatcher.matchMacosSnapshot(snapshot, macosPack).some(
    (match) => match.confirmed) ? "CONFIRMED" : "NOT_DETECTED";
  return { actual, coverageHealthy: Object.values(snapshot.permissions).every(Boolean) };
}

function write(name, value) {
  writeFileSync(resolve("accuracy-runner-results", name), `${JSON.stringify(value, null, 2)}\n`);
}

function windowsFixture(scenario) {
  const fixture = scenario.observation;
  if (!fixture || !["PROCESS", "OVERLAY", "CAPTURE_EXCLUDED", "AUDIO", "EXTENSION"]
      .includes(fixture.channel) || !fixture.ruleKey
      || (fixture.channel !== "EXTENSION" && !/^[0-9a-f]{64}$/.test(fixture.observedIdentity))) {
    throw new Error(`Scenario ${scenario.id} has an invalid captured Windows observation.`);
  }
  return fixture;
}

function macosFixture(scenario) {
  const fixture = scenario.observation;
  if (!fixture?.ruleKey || !["PROCESS", "OVERLAY", "AUDIO"].includes(fixture.channel)
      || !fixture.observedIdentity) {
    throw new Error(`Scenario ${scenario.id} has an invalid captured macOS observation.`);
  }
  return fixture;
}

function browserResult(scenario, fixture, rule) {
  const evidence = browserMatcher.normalizeBrowserEvidence({ eventType: "BROWSER_EXTENSION_MATCH",
    payload: { extensionId: fixture.extensionId, enabled: fixture.enabled, version: "1.0.0",
      installationType: "normal", ruleKey: rule.key, ruleVersion: rule.version,
      rulePackVersion: windowsPack.version } });
  const actual = evidence && rule.extensionIds?.includes(evidence.payload.extensionId)
    && evidence.payload.enabled === true ? "CONFIRMED" : "NOT_DETECTED";
  return { actual, coverageHealthy: Boolean(evidence) };
}

function loadPack(environmentName, fallback, expectedVersion) {
  const path = requiredReleaseValue(environmentName, fallback);
  const pack = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (pack.version !== expectedVersion || !Array.isArray(pack.rules) || !pack.rules.length
      || !pack.signature || Date.parse(pack.expiresAt) <= Date.now()) {
    throw new Error(`${path} is not the active ${expectedVersion} release rule pack.`);
  }
  return pack;
}

function requiredReleaseValue(name, fixtureFallback) {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fixtureMode) return name.endsWith("_PATH") ? fixtureFallback
    : readFileSync(resolve(fixtureFallback), "utf8").trim();
  throw new Error(`${name} is required for a release accuracy run.`);
}
