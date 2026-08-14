import type { MacosRulePack } from "@authenti8/detection-rules";
import { parseActivationUrl } from "./config.js";
import { MacosAgent } from "./macos-agent.js";

async function main() {
  const enrollmentToken = parseActivationUrl(process.argv[2] ?? "");
  const apiOrigin = required("AUTHENTI8_API_ORIGIN");
  const rulePackPublicKey = required("AUTHENTI8_MACOS_RULE_PACK_PUBLIC_KEY");
  const refreshRulePack = () => fetchRulePack(apiOrigin);
  const rulePack = await refreshRulePack();
  const agent = new MacosAgent({ apiOrigin, enrollmentToken,
    agentVersion: process.env.AUTHENTI8_AGENT_VERSION ?? "0.1.0", rulePack, rulePackPublicKey,
    refreshRulePack, sensorPath: process.env.AUTHENTI8_MACOS_SENSOR_PATH });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => agent.stop());
  await agent.run();
}

async function fetchRulePack(apiOrigin: string) {
  const response = await fetch(new URL("/api/v1/agent/rules/macos", apiOrigin),
    { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("The signed macOS rule pack is unavailable.");
  return response.json() as Promise<MacosRulePack>;
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Authenti8 Verify failed."}\n`);
  process.exitCode = 1;
});
