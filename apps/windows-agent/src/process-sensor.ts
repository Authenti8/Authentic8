import { createHash } from "node:crypto";
import type { ProcessEvidence } from "@authenti8/event-schemas";
import { runSensor } from "./powershell.js";

const identityCache = new Map<string, CachedIdentity>();

export async function collectProcesses() {
  const rows = await runSensor<ProcessRow>("process-sensor.ps1");
  await populateIdentityCache(rows);
  return rows.map(normalizeProcess).filter((row): row is ProcessEvidence => Boolean(row));
}

function normalizeProcess(row: ProcessRow): ProcessEvidence | undefined {
  if (!Number.isInteger(row.processId) || row.processId < 0 || !row.executableName) return undefined;
  const cacheKey = `${row.path ?? ""}:${row.size ?? 0}:${row.modifiedAt ?? ""}`;
  const identity = identityCache.get(cacheKey) ?? {};
  return { processId: row.processId, executableName: row.executableName,
    executablePathHash: row.path ? sha256(row.path.toLowerCase()) : undefined,
    executableSha256: identity.sha256, signerSubject: identity.signerSubject,
    signerThumbprint: identity.signerThumbprint, productName: clean(row.productName),
    fileVersion: row.fileVersion,
    parentProcessId: row.parentProcessId, processStartTime: row.startedAt, change: "STARTED" };
}

async function populateIdentityCache(rows: ProcessRow[]) {
  const missing = rows.filter((row) => row.path && !identityCache.has(cacheKey(row)));
  if (missing.length === 0) return;
  const paths = [...new Set(missing.map((row) => row.path!))];
  const encoded = Buffer.from(JSON.stringify(paths)).toString("base64");
  const identities = await runSensor<IdentityRow>("process-identity.ps1", [encoded]);
  const byPath = new Map(identities.map((item) => [item.path.toLowerCase(), item]));
  for (const row of missing) {
    const item = byPath.get(row.path!.toLowerCase());
    identityCache.set(cacheKey(row), { sha256: validHash(item?.sha256) ? item!.sha256!.toLowerCase() : undefined,
      signerSubject: clean(item?.signerSubject), signerThumbprint: clean(item?.signerThumbprint) });
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function validHash(value?: string) {
  return Boolean(value && /^[a-f0-9]{64}$/i.test(value));
}

function clean(value?: string) {
  return value?.trim().slice(0, 500) || undefined;
}

function cacheKey(row: ProcessRow) {
  return `${row.path ?? ""}:${row.size ?? 0}:${row.modifiedAt ?? ""}`;
}

type CachedIdentity = { sha256?: string; signerSubject?: string; signerThumbprint?: string };
type ProcessRow = { processId: number; parentProcessId?: number; executableName: string; path?: string;
  size?: number; modifiedAt?: string; productName?: string; fileVersion?: string; startedAt?: string };
type IdentityRow = { path: string; sha256?: string; signerSubject?: string; signerThumbprint?: string };
