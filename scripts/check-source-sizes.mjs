import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const sourceExtensions = /\.(?:[cm]?[jt]sx?|css|sql|sh)$/;
const result = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const oversized = result.stdout
  .split("\0")
  .filter((file) => file && sourceExtensions.test(file) && existsSync(file))
  .map((file) => ({ file, lines: readFileSync(file, "utf8").split("\n").length }))
  .filter(({ lines }) => lines > 500);

if (oversized.length > 0) {
  for (const { file, lines } of oversized) {
    console.error(`[guardian] ${file} has ${lines} lines (maximum: 500).`);
  }
  process.exit(1);
}

console.log("[guardian] Authored source files are within the 500-line limit.");
