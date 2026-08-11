import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, win32 } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const staging = resolve(root, ".package");
const release = resolve(root, "release");
const executable = resolve(release, "Authenti8Verify.exe");
const packageMetadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const archive = resolve(release, `Authenti8Verify-${packageMetadata.version}.zip`);
const installer = resolve(release, "Authenti8VerifySetup.exe");
const nativeHost = resolve(release, "Authenti8VerifyNativeHost.exe");
const nativeScripts = collectNativeScripts(resolve(root, "native"));

assertReleaseEnvironment();
rmSync(staging, { recursive: true, force: true });
rmSync(release, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(release, { recursive: true });
await build({ entryPoints: [resolve(root, "src/cli.ts")], bundle: true, platform: "node",
  format: "cjs", outfile: resolve(staging, "agent.cjs"), define: {
    __AUTHENTI8_API_ORIGIN__: JSON.stringify(process.env.AUTHENTI8_API_ORIGIN),
    __AUTHENTI8_RULE_KEY__: JSON.stringify(process.env.AUTHENTI8_RULE_PACK_PUBLIC_KEY),
    __AUTHENTI8_UPDATE_KEY__: JSON.stringify(process.env.AUTHENTI8_UPDATE_PUBLIC_KEY),
    __AUTHENTI8_AGENT_VERSION__: JSON.stringify(packageMetadata.version),
    __AUTHENTI8_NATIVE_SCRIPTS__: JSON.stringify(nativeScripts),
  } });
const seaConfig = resolve(staging, "sea-config.json");
writeFileSync(seaConfig, JSON.stringify({ main: resolve(staging, "agent.cjs"),
  output: executable, disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ["--build-sea", seaConfig], { stdio: "inherit" });
signExecutable(executable);
await build({ entryPoints: [resolve(root, "src/native-host-cli.ts")], bundle: true, platform: "node",
  format: "cjs", outfile: resolve(staging, "native-host.cjs"), define: {
    __AUTHENTI8_AGENT_VERSION__: JSON.stringify(packageMetadata.version),
  } });
const nativeHostSeaConfig = resolve(staging, "native-host-sea-config.json");
writeFileSync(nativeHostSeaConfig, JSON.stringify({ main: resolve(staging, "native-host.cjs"),
  output: nativeHost, disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ["--build-sea", nativeHostSeaConfig], { stdio: "inherit" });
signExecutable(nativeHost);
cpSync(resolve(root, "native"), resolve(release, "native"), { recursive: true });
cpSync(resolve(root, "installer"), resolve(release, "installer"), { recursive: true });
execFileSync(systemExecutable("tar.exe"), ["-a", "-c", "-f", archive,
  "Authenti8Verify.exe", "Authenti8VerifyNativeHost.exe", "native", "installer"],
{ cwd: release, stdio: "inherit" });
await build({ entryPoints: [resolve(root, "src/installer-cli.ts")], bundle: true, platform: "node",
  format: "cjs", outfile: resolve(staging, "installer.cjs"), define: {
    __AUTHENTI8_RELEASE_ARCHIVE__: JSON.stringify(readFileSync(archive).toString("base64")),
    __AUTHENTI8_EXTENSION_ID__: JSON.stringify(process.env.AUTHENTI8_CHROME_EXTENSION_ID),
  } });
const installerSeaConfig = resolve(staging, "installer-sea-config.json");
writeFileSync(installerSeaConfig, JSON.stringify({ main: resolve(staging, "installer.cjs"),
  output: installer, disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ["--build-sea", installerSeaConfig], { stdio: "inherit" });
signExecutable(installer);

function assertReleaseEnvironment() {
  if (process.platform !== "win32") throw new Error("Windows packaging must run on Windows.");
  if (Number(process.versions.node.split(".")[0]) < 26) throw new Error("Node 26+ is required for --build-sea.");
  for (const name of ["AUTHENTI8_API_ORIGIN", "AUTHENTI8_RULE_PACK_PUBLIC_KEY",
    "AUTHENTI8_UPDATE_PUBLIC_KEY", "AUTHENTI8_CHROME_EXTENSION_ID",
    "WINDOWS_SIGNTOOL", "WINDOWS_CERT_THUMBPRINT"]) {
    if (!process.env[name]) throw new Error(`${name} is required for a signed Windows build.`);
  }
  if (!/^[a-p]{32}$/.test(process.env.AUTHENTI8_CHROME_EXTENSION_ID)) {
    throw new Error("AUTHENTI8_CHROME_EXTENSION_ID is invalid.");
  }
}

function signExecutable(path) {
  execFileSync(process.env.WINDOWS_SIGNTOOL, ["sign", "/sha1",
    process.env.WINDOWS_CERT_THUMBPRINT, "/fd", "SHA256", "/tr",
    process.env.WINDOWS_TIMESTAMP_URL ?? "http://timestamp.digicert.com", "/td", "SHA256", path],
  { stdio: "inherit" });
}

function systemExecutable(name) {
  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  if (!systemRoot || !win32.isAbsolute(systemRoot) || !/^[a-z]:\\/i.test(systemRoot)) {
    throw new Error("Windows did not provide a valid system directory.");
  }
  return win32.join(win32.normalize(systemRoot), "System32", name);
}

function collectNativeScripts(directory) {
  return Object.fromEntries(["apply-update.ps1", "audio-sensor.ps1", "credential-store.ps1",
    "process-identity.ps1", "process-sensor.ps1", "signature-check.ps1", "window-sensor.ps1"]
    .map((name) => [name, readFileSync(resolve(directory, name)).toString("base64")]));
}
