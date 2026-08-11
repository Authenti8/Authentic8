import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export function recoverInterruptedUpdate(executablePath = process.execPath) {
  const installDirectory = dirname(executablePath);
  const journalPath = join(installDirectory, ".update-journal.json");
  if (!existsSync(journalPath)) return;
  const journal = readJournal(journalPath, installDirectory);
  const executableCommitted = journal.phase === "complete"
    || (journal.phase === "commit_executable"
      && fileHash(executablePath) === journal.newExecutableSha256);
  if (!executableCommitted) restoreDirectories(installDirectory, journal.backup);
  cleanup(journal, journalPath);
}

function restoreDirectories(installDirectory: string, backup: string) {
  for (const name of ["native", "installer"]) {
    const saved = join(backup, name); const installed = join(installDirectory, name);
    if (!existsSync(saved)) continue;
    rmSync(installed, { recursive: true, force: true });
    renameSync(saved, installed);
  }
  const savedHost = join(backup, "Authenti8VerifyNativeHost.exe");
  const installedHost = join(installDirectory, "Authenti8VerifyNativeHost.exe");
  rmSync(installedHost, { force: true });
  if (existsSync(savedHost)) {
    renameSync(savedHost, installedHost);
  }
}

function cleanup(journal: UpdateJournal, journalPath: string) {
  rmSync(journal.backup, { recursive: true, force: true });
  rmSync(journal.staging, { recursive: true, force: true });
  rmSync(journal.packagePath, { force: true });
  rmSync(journalPath, { force: true });
}

function readJournal(path: string, installDirectory: string): UpdateJournal {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<UpdateJournal>;
  if (!["prepared", "assets_replaced", "commit_executable", "complete"].includes(value.phase ?? "")
    || !safePath(value.backup, installDirectory) || !safePath(value.staging, tmpdir())
    || !safePath(value.packagePath, tmpdir())
    || !/^[a-f0-9]{64}$/.test(value.newExecutableSha256 ?? "")) {
    throw new Error("The interrupted update journal is invalid.");
  }
  return value as UpdateJournal;
}

function safePath(value?: string, parent?: string) {
  if (!value || !isAbsolute(value)) return false;
  return !parent || resolve(value).toLowerCase()
    .startsWith(`${resolve(parent).toLowerCase()}${sep}`);
}

function fileHash(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

type UpdateJournal = { phase: string; backup: string; staging: string;
  packagePath: string; newExecutableSha256: string };
