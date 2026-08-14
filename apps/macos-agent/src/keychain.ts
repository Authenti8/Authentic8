import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MacosIdentity } from "./types.js";

const execute = promisify(execFile);
const service = "com.authenti8.verify.enrollment";

export async function loadIdentity(token: string) {
  try {
    const { stdout } = await execute("/usr/bin/security", ["find-generic-password", "-s", service,
      "-a", account(token), "-w"], { timeout: 5_000, maxBuffer: 512 * 1024 });
    const value = JSON.parse(stdout.trim()) as MacosIdentity;
    return valid(value) ? value : undefined;
  } catch { return undefined; }
}

export async function saveIdentity(token: string, identity: MacosIdentity) {
  await execute("/usr/bin/security", ["add-generic-password", "-U", "-s", service,
    "-a", account(token), "-w", JSON.stringify(identity)], { timeout: 5_000 });
}

export async function removeIdentity(token: string) {
  try { await execute("/usr/bin/security", ["delete-generic-password", "-s", service,
    "-a", account(token)], { timeout: 5_000 }); } catch { /* Idempotent cleanup. */ }
}

function account(token: string) { return createHash("sha256").update(token).digest("hex"); }

function valid(value: MacosIdentity) {
  return Boolean(value?.deviceId && value.verificationSessionId && value.privateKey
    && Date.parse(value.eligibleEnd) + 5 * 60_000 > Date.now());
}
