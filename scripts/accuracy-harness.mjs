import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const manifests = process.argv.slice(2);
const allowFixtures = process.env.AUTHENTI8_ACCURACY_ALLOW_FIXTURES === "true";
const contracts = { WINDOWS: ["accessibility-noise-removal", "benign-virtual-audio",
  "capture-excluded-overlay", "cluely-active", "google-meet", "hidden-overlay", "notion-vscode",
  "parakeet-active", "recorders-password-managers", "slack-teams-zoom",
  "supported-extension-active", "virtual-audio-ai"], MACOS: ["accessibility-noise-removal",
  "benign-virtual-audio", "cluely-active", "hidden-overlay", "meet-slack-teams-zoom",
  "notion-vscode", "parakeet-active", "recorders-password-managers", "virtual-audio-ai"] };
const positives = { WINDOWS: new Set(["capture-excluded-overlay", "cluely-active",
  "hidden-overlay", "parakeet-active", "supported-extension-active", "virtual-audio-ai"]),
MACOS: new Set(["cluely-active", "hidden-overlay", "parakeet-active", "virtual-audio-ai"]) };
if (!manifests.length) fail("Pass at least one accuracy scenario manifest.");
const results = manifests.map(loadManifest);
const failed = results.filter((result) => !result.passed);
writeFileSync(resolve("accuracy-results.json"), `${JSON.stringify({ results }, null, 2)}\n`);
for (const result of results) {
  console.log(`${result.platform}: ${result.passed ? "PASS" : "FAIL"} `
    + `(tp=${result.truePositives}, fp=${result.falsePositives}, missed=${result.missedDetections}, `
    + `coverage=${result.coverageFailures})`);
}
if (failed.length) fail("Accuracy release gate failed.");

function loadManifest(path) {
  const input = JSON.parse(readFileSync(resolve(path), "utf8"));
  const validSource = input.evidenceSource === "NATIVE_E2E"
    || (allowFixtures && input.evidenceSource === "MATCHER_FIXTURE");
  if (!validSource || !input.generatedAt
      || !["WINDOWS", "MACOS"].includes(input.platform) || !input.osVersion
      || !input.agentVersion || !input.rulePackVersion || input.scenarioContractVersion !== "pilot-v1"
      || (input.evidenceSource === "NATIVE_E2E" && !/^[0-9a-f]{64}$/.test(input.artifactDigest))
      || !Array.isArray(input.scenarios)
      || !input.scenarios.length) fail(`${path} has invalid metadata.`);
  const names = new Set();
  for (const scenario of input.scenarios) {
    if (!scenario.id || names.has(scenario.id)) fail(`${path} has a duplicate or missing scenario ID.`);
    names.add(scenario.id);
    const canonicalExpected = positives[input.platform].has(scenario.id)
      ? "CONFIRMED" : "NOT_DETECTED";
    if (!scenario.observation || scenario.expected !== canonicalExpected
        || !["CONFIRMED", "NOT_DETECTED", "UNABLE_TO_VERIFY"].includes(scenario.actual)
        || typeof scenario.coverageHealthy !== "boolean") fail(`${path} has an invalid scenario.`);
  }
  const expectedIds = contracts[input.platform];
  if (!expectedIds || JSON.stringify([...names].sort()) !== JSON.stringify(expectedIds)) {
    fail(`${path} does not satisfy the ${input.platform} pilot-v1 scenario contract.`);
  }
  const truePositives = count(input, "CONFIRMED", "CONFIRMED");
  const falsePositives = count(input, "NOT_DETECTED", "CONFIRMED");
  const missedDetections = input.scenarios.filter((item) =>
    item.expected === "CONFIRMED" && item.actual !== "CONFIRMED").length;
  const coverageFailures = input.scenarios.filter((item) => !item.coverageHealthy).length;
  return { ...input, truePositives, falsePositives, missedDetections, coverageFailures,
    passed: falsePositives === 0 && missedDetections === 0 && coverageFailures === 0 };
}

function count(input, expected, actual) {
  return input.scenarios.filter((item) => item.expected === expected && item.actual === actual).length;
}

function fail(message) { console.error(message); process.exit(1); }
