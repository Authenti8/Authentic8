import { createHash, createPublicKey, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SignedUpdateManifest } from "./types.js";
import { canonicalJson } from "./event-chain.js";
import { nativeScriptInvocation } from "./powershell.js";

export async function installVerifiedUpdate(update: VerifiedUpdate, activationUrl: string) {
  if (basename(process.execPath).toLowerCase() !== "authenti8verify.exe") {
    throw new Error("Automatic updates require an installed Authenti8 Verify build.");
  }
  const path = join(tmpdir(), `Authenti8Verify-${update.manifest.version}.zip`);
  await writeFile(path, update.bytes, { mode: 0o700 });
  const invocation = nativeScriptInvocation("apply-update.ps1",
    [path, process.execPath, String(process.pid), activationUrl, update.manifest.sha256]);
  const child = spawn(invocation.executable, invocation.arguments,
  { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

export async function checkForUpdate(manifestUrl: URL, currentVersion: string, publicKey: string) {
  const response = await fetch(manifestUrl, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("The signed Authenti8 update policy is unavailable.");
  const manifest = await response.json() as SignedUpdateManifest;
  const verified = verifyUpdateManifest(manifest, publicKey);
  const belowMinimum = compareVersions(currentVersion, verified.minimumVersion) < 0;
  const updateAvailable = compareVersions(currentVersion, verified.version) < 0;
  if (belowMinimum && (!updateAvailable
    || compareVersions(verified.version, verified.minimumVersion) < 0)) {
    throw new Error("No verified update satisfies the minimum supported version.");
  }
  if (!updateAvailable) return undefined;
  const download = await fetch(verified.downloadUrl, { signal: AbortSignal.timeout(60_000) });
  if (!download.ok) throw new Error("The verified Authenti8 update could not be downloaded.");
  const bytes = new Uint8Array(await download.arrayBuffer());
  verifyDownloadedUpdate(bytes, verified.sha256);
  return { manifest: verified, bytes };
}

export function verifyUpdateManifest(manifest: SignedUpdateManifest, publicKey: string) {
  assertManifest(manifest);
  const { signature, ...unsigned } = manifest;
  const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Update key must use Ed25519.");
  const valid = verify(null, Buffer.from(canonicalJson(unsigned)), key,
    Buffer.from(signature, "base64url"));
  if (!valid) throw new Error("Update manifest signature is invalid.");
  return unsigned;
}

export function verifyDownloadedUpdate(bytes: Uint8Array, expectedSha256: string) {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256.toLowerCase()) throw new Error("Update package hash does not match.");
}

function assertManifest(manifest: SignedUpdateManifest) {
  if (!semver(manifest.version) || !semver(manifest.minimumVersion)) {
    throw new Error("Update manifest version is invalid.");
  }
  const url = new URL(manifest.downloadUrl);
  if (url.protocol !== "https:") throw new Error("Updates must use HTTPS.");
  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256)) throw new Error("Update hash is invalid.");
  if (!Number.isFinite(Date.parse(manifest.publishedAt))) throw new Error("Update timestamp is invalid.");
}

function semver(value: string) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function compareVersions(left: string, right: string) {
  const [leftCore, leftPrerelease] = versionParts(left);
  const [rightCore, rightPrerelease] = versionParts(right);
  const a = leftCore!.split(".").map(Number);
  const b = rightCore!.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  if (leftPrerelease === undefined) return rightPrerelease === undefined ? 0 : 1;
  if (rightPrerelease === undefined) return -1;
  const leftIdentifiers = leftPrerelease.split(".");
  const rightIdentifiers = rightPrerelease.split(".");
  for (let index = 0; index < Math.max(leftIdentifiers.length, rightIdentifiers.length); index += 1) {
    const comparison = compareIdentifier(leftIdentifiers[index], rightIdentifiers[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compareIdentifier(left?: string, right?: string) {
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  const leftNumeric = /^\d+$/.test(left); const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function versionParts(version: string): [string, string?] {
  const separator = version.indexOf("-");
  return separator < 0 ? [version] : [version.slice(0, separator), version.slice(separator + 1)];
}

type VerifiedUpdate = NonNullable<Awaited<ReturnType<typeof checkForUpdate>>>;
