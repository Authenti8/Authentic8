import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync,
  writeFileSync } from "node:fs";
import { resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { inject } from "postject";

const root = resolve(import.meta.dirname, "..");
const staging = resolve(root, ".package");
const release = resolve(root, "release");
const executable = resolve(release, "Authenti8Verify.exe");
const packageMetadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const archive = resolve(release, `Authenti8Verify-${packageMetadata.version}.zip`);
const installer = resolve(release, "Authenti8VerifySetup.exe");
const nativeHost = resolve(release, "Authenti8VerifyNativeHost.exe");
const nativeScripts = collectNativeScripts(resolve(root, "native"));
assertReferencedScriptsEmbedded(nativeScripts, resolve(root, "src"));
const context = releaseContext();

rmSync(staging, { recursive: true, force: true });
rmSync(release, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(release, { recursive: true });
await build({ entryPoints: [resolve(root, "src/cli.ts")], bundle: true, platform: "node",
  format: "cjs", outfile: resolve(staging, "agent.cjs"), define: {
    __AUTHENTI8_API_ORIGIN__: JSON.stringify(context.apiOrigin),
    __AUTHENTI8_RULE_KEY__: JSON.stringify(context.rulePublicKey),
    __AUTHENTI8_UPDATE_KEY__: JSON.stringify(context.updatePublicKey),
    __AUTHENTI8_BUILD_CHANNEL__: JSON.stringify(context.channel),
    __AUTHENTI8_DEVELOPMENT_RULE_PACK__: context.developmentRulePack
      ? JSON.stringify(context.developmentRulePack) : "undefined",
    __AUTHENTI8_AGENT_VERSION__: JSON.stringify(packageMetadata.version),
    __AUTHENTI8_NATIVE_SCRIPTS__: JSON.stringify(nativeScripts),
    "import.meta.url": JSON.stringify(pathToFileURL(resolve(root, "src/powershell.ts")).href),
  } });
await buildSeaExecutable(resolve(staging, "agent.cjs"), executable, "agent");
signExecutable(executable);
await build({ entryPoints: [resolve(root, "src/native-host-cli.ts")], bundle: true, platform: "node",
  format: "cjs", outfile: resolve(staging, "native-host.cjs"), define: {
    __AUTHENTI8_AGENT_VERSION__: JSON.stringify(packageMetadata.version),
    __AUTHENTI8_NATIVE_SCRIPTS__: JSON.stringify(nativeScripts),
    "import.meta.url": JSON.stringify(pathToFileURL(resolve(root, "src/powershell.ts")).href),
  } });
await buildSeaExecutable(resolve(staging, "native-host.cjs"), nativeHost, "native-host");
signExecutable(nativeHost);
cpSync(resolve(root, "native"), resolve(release, "native"), { recursive: true });
cpSync(resolve(root, "installer"), resolve(release, "installer"), { recursive: true });
execFileSync(systemExecutable("tar.exe"), ["-a", "-c", "-f", archive,
  "Authenti8Verify.exe", "Authenti8VerifyNativeHost.exe", "native", "installer"],
{ cwd: release, stdio: "inherit" });
await build({ entryPoints: [resolve(root, "src/installer-cli.ts")], bundle: true, platform: "node",
  format: "cjs", outfile: resolve(staging, "installer.cjs"), define: {
    __AUTHENTI8_RELEASE_ARCHIVE__: JSON.stringify(readFileSync(archive).toString("base64")),
    __AUTHENTI8_EXTENSION_ID__: JSON.stringify(context.extensionId),
  } });
await buildSeaExecutable(resolve(staging, "installer.cjs"), installer, "installer");
signExecutable(installer);

function releaseContext() {
  if (process.platform !== "win32") throw new Error("Windows packaging must run on Windows.");
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("Node 20+ is required for SEA packaging.");
  const channel = process.env.AUTHENTI8_BUILD_CHANNEL === "development" ? "development" : "production";
  for (const name of ["AUTHENTI8_API_ORIGIN", "WINDOWS_SIGNTOOL", "WINDOWS_CERT_THUMBPRINT"]) {
    if (!process.env[name]) throw new Error(`${name} is required for a signed Windows build.`);
  }
  const apiOrigin = secureOrigin(process.env.AUTHENTI8_API_ORIGIN);
  if (channel === "development") {
    const development = developmentRuleMaterial();
    return { channel, apiOrigin, extensionId: "", rulePublicKey: development.publicKey,
      updatePublicKey: development.publicKey, developmentRulePack: development.pack };
  }
  for (const name of ["AUTHENTI8_RULE_PACK_PUBLIC_KEY", "AUTHENTI8_UPDATE_PUBLIC_KEY",
    "AUTHENTI8_CHROME_EXTENSION_ID"]) {
    if (!process.env[name]) throw new Error(`${name} is required for a production Windows build.`);
  }
  if (!/^[a-p]{32}$/.test(process.env.AUTHENTI8_CHROME_EXTENSION_ID)) {
    throw new Error("AUTHENTI8_CHROME_EXTENSION_ID is invalid.");
  }
  return { channel, apiOrigin, extensionId: process.env.AUTHENTI8_CHROME_EXTENSION_ID,
    rulePublicKey: process.env.AUTHENTI8_RULE_PACK_PUBLIC_KEY,
    updatePublicKey: process.env.AUTHENTI8_UPDATE_PUBLIC_KEY, developmentRulePack: undefined };
}

async function buildSeaExecutable(entrypoint, destination, name) {
  const blob = resolve(staging, `${name}.blob`);
  const config = resolve(staging, `${name}-sea-config.json`);
  writeFileSync(config, JSON.stringify({ main: entrypoint, output: blob,
    disableExperimentalSEAWarning: true }));
  execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });
  copyFileSync(process.execPath, destination);
  // The Node runtime distributed for Windows is Authenticode-signed. Its signature must be
  // removed before changing PE resources; the completed executable is signed immediately after.
  execFileSync(process.env.WINDOWS_SIGNTOOL, ["remove", "/s", destination], { stdio: "inherit" });
  await inject(destination, "NODE_SEA_BLOB", readFileSync(blob), {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  });
}

function signExecutable(path) {
  const arguments_ = ["sign", "/fd", "SHA256"];
  if (context.channel === "development") {
    if (!process.env.WINDOWS_CERT_PFX || !process.env.WINDOWS_CERT_PFX_PASSWORD) {
      throw new Error("Development signing requires an ephemeral PFX and password.");
    }
    arguments_.push("/f", process.env.WINDOWS_CERT_PFX,
      "/p", process.env.WINDOWS_CERT_PFX_PASSWORD);
  } else {
    arguments_.push("/sha1", process.env.WINDOWS_CERT_THUMBPRINT, "/tr",
      process.env.WINDOWS_TIMESTAMP_URL ?? "http://timestamp.digicert.com", "/td", "SHA256");
  }
  arguments_.push(path);
  execFileSync(process.env.WINDOWS_SIGNTOOL, arguments_, { stdio: "inherit" });
}

function secureOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value.replace(/\/$/, "")) throw new Error();
    return url.origin;
  } catch { throw new Error("AUTHENTI8_API_ORIGIN must be an HTTPS origin without a path."); }
}

function developmentRuleMaterial() {
  const keys = generateKeyPairSync("ed25519");
  const unsigned = { version: "development-empty", expiresAt:
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(), rules: [] };
  const signature = sign(null, Buffer.from(canonicalJson(unsigned)), keys.privateKey)
    .toString("base64url");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  return { publicKey, pack: { ...unsigned, signature } };
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function systemExecutable(name) {
  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  if (!systemRoot || !win32.isAbsolute(systemRoot) || !/^[a-z]:\\/i.test(systemRoot)) {
    throw new Error("Windows did not provide a valid system directory.");
  }
  return win32.join(win32.normalize(systemRoot), "System32", name);
}

function collectNativeScripts(directory) {
  return Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith(".ps1")).sort()
    .map((name) => [name, readFileSync(resolve(directory, name)).toString("base64")]));
}

function assertReferencedScriptsEmbedded(scripts, sourceDirectory) {
  const references = new Set(readdirSync(sourceDirectory).filter((name) => name.endsWith(".ts"))
    .flatMap((name) => [...readFileSync(resolve(sourceDirectory, name), "utf8")
      .matchAll(/["']([a-z0-9-]+\.ps1)["']/gi)].map((match) => match[1])));
  const missing = [...references].filter((name) => !scripts[name]);
  if (missing.length) throw new Error(`Native scripts are not embedded: ${missing.join(", ")}`);
}
