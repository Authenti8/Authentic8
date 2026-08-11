import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsSystemExecutable } from "./powershell.js";

declare const __AUTHENTI8_RELEASE_ARCHIVE__: string;
declare const __AUTHENTI8_EXTENSION_ID__: string;

function main() {
  const activationUrl = process.argv[2] ?? "";
  if (activationUrl && !/^authenti8:\/\/verify\?token=[a-f0-9]{64}$/.test(activationUrl)) {
    throw new Error("The Authenti8 activation URL is invalid.");
  }
  const staging = mkdtempSync(join(tmpdir(), "Authenti8-Setup-"));
  const archive = join(staging, "release.zip");
  const tar = windowsSystemExecutable("tar.exe");
  const powershell = windowsSystemExecutable("powershell.exe");
  try {
    writeFileSync(archive, Buffer.from(__AUTHENTI8_RELEASE_ARCHIVE__, "base64"), { mode: 0o600 });
    execFileSync(tar, ["-xf", archive, "-C", staging], { stdio: "ignore" });
    rmSync(archive, { force: true });
    const arguments_ = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy",
      "Bypass", "-File", join(staging, "installer", "install.ps1"),
      "-PackageDirectory", staging, "-ExtensionId", __AUTHENTI8_EXTENSION_ID__];
    if (activationUrl) arguments_.push("-ActivationUrl", activationUrl);
    execFileSync(powershell, arguments_, { stdio: "inherit", windowsHide: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

try { main(); }
catch (error) {
  const message = error instanceof Error ? error.message : "Authenti8 Verify setup failed.";
  process.stderr.write(`${message}\n`); process.exitCode = 1;
}
