import { parseActivationUrl } from "./config.js";
import { WindowsAgent } from "./windows-agent.js";
import { verifyInstalledSignature } from "./self-integrity.js";
import { loadReleaseBootstrap } from "./release-bootstrap.js";
import { installVerifiedUpdate } from "./update-verifier.js";
import { recoverInterruptedUpdate } from "./update-recovery.js";

declare const __AUTHENTI8_AGENT_VERSION__: string | undefined;

async function main() {
  recoverInterruptedUpdate();
  await verifyInstalledSignature();
  const activationUrl = process.argv[2] ?? "";
  const enrollmentToken = parseActivationUrl(activationUrl);
  const embeddedVersion = typeof __AUTHENTI8_AGENT_VERSION__ === "string"
    ? __AUTHENTI8_AGENT_VERSION__ : undefined;
  const agentVersion = embeddedVersion ?? process.env.AUTHENTI8_AGENT_VERSION ?? "0.1.0";
  const release = await loadReleaseBootstrap(agentVersion);
  if (release.update) { await installVerifiedUpdate(release.update, activationUrl); return; }
  const agent = new WindowsAgent({ apiOrigin: release.apiOrigin,
    rulePack: release.rulePack, rulePackPublicKey: release.rulePackPublicKey,
    refreshRulePack: release.refreshRulePack,
    enrollmentToken, agentVersion,
    rulePackVersion: release.rulePack.version });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => agent.stop());
  }
  await agent.run();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Authenti8 Verify failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
