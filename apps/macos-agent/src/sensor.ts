import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { MacosSnapshot } from "./types.js";

const execute = promisify(execFile);

export async function collectMacosSnapshot(sensorPath?: string,
  priorApplications: MacosSnapshot["applications"] = []) {
  if (process.platform !== "darwin") throw new Error("The macOS sensor requires macOS.");
  const packaged = basename(process.execPath) === "Authenti8Verify";
  const bundled = resolve(dirname(process.execPath), "..", "Resources", "Authenti8MacSensor");
  const development = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "Authenti8MacSensor");
  const executable = sensorPath ?? (packaged ? bundled : development);
  await access(executable, constants.X_OK);
  const identityCache = Object.fromEntries(priorApplications.filter((item) => item.identityKey)
    .map((item) => [item.identityKey!, { executableSha256: item.executableSha256,
      teamIdentifier: item.teamIdentifier }]));
  const encodedCache = Buffer.from(JSON.stringify(identityCache)).toString("base64");
  const { stdout } = await execute(executable, [], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, AUTHENTI8_IDENTITY_CACHE: encodedCache } });
  const value = JSON.parse(stdout) as MacosSnapshot;
  if (!snapshot(value)) throw new Error("The macOS sensor returned invalid evidence.");
  return value;
}

function snapshot(value: MacosSnapshot) {
  return Boolean(value && Array.isArray(value.applications) && Array.isArray(value.windows)
    && Array.isArray(value.audioDevices) && typeof value.permissions?.accessibility === "boolean"
    && typeof value.permissions.screenRecording === "boolean");
}
