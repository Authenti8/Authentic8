import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const platform = required("AUTHENTI8_ACCURACY_PLATFORM").toUpperCase();
if (!["WINDOWS", "MACOS"].includes(platform)) throw new Error("Unsupported native platform.");
const driver = resolve(required("AUTHENTI8_NATIVE_ACCURACY_DRIVER"));
const candidate = platform === "WINDOWS"
  ? { binary: "apps/windows-agent/release/Authenti8VerifySetup.exe",
      package: "apps/windows-agent/package.json" }
  : { binary: "apps/macos-agent/release/Authenti8Verify.zip",
      package: "apps/macos-agent/package.json" };
const binary = resolve(candidate.binary);
const packageVersion = JSON.parse(readFileSync(resolve(candidate.package), "utf8")).version;
const directory = resolve("native-accuracy-output", platform.toLowerCase());
const resultPath = resolve(directory, `${platform.toLowerCase()}.json`);
const copiedBinary = resolve(directory, `${platform.toLowerCase()}-agent.bin`);
mkdirSync(directory, { recursive: true });
execFileSync(driver, ["--platform", platform, "--artifact", binary, "--output", resultPath,
  "--commit", required("GITHUB_SHA")], { stdio: "inherit", timeout: 15 * 60_000 });
const document = JSON.parse(readFileSync(resultPath, "utf8"));
const digest = createHash("sha256").update(readFileSync(binary)).digest("hex");
if (document.platform !== platform || document.agentVersion !== packageVersion
    || document.evidenceSource !== "NATIVE_E2E"
    || document.commitSha !== process.env.GITHUB_SHA || document.artifactDigest !== digest) {
  throw new Error(`${platform} driver output does not describe the tested release artifact.`);
}
copyFileSync(binary, copiedBinary);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required on the native accuracy runner.`);
  return value;
}
