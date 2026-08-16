import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

for (const platform of ["windows", "macos"]) {
  const result = JSON.parse(readFileSync(resolve("native-accuracy-output", platform,
    `${platform}.json`), "utf8"));
  const digest = createHash("sha256").update(readFileSync(resolve("native-accuracy-output",
    platform, `${platform}-agent.bin`))).digest("hex");
  if (result.platform !== platform.toUpperCase() || result.evidenceSource !== "NATIVE_E2E"
      || result.commitSha !== process.env.GITHUB_SHA || result.artifactDigest !== digest) {
    throw new Error(`${platform} evidence failed post-transfer provenance verification.`);
  }
}
