import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { inject } from "postject";

const root = resolve(import.meta.dirname, "..");
const staging = resolve(root, ".package");
const release = resolve(root, "release");
const app = resolve(release, "Authenti8 Verify.app");
const contents = resolve(app, "Contents");
const executable = resolve(contents, "MacOS", "Authenti8Verify");
const sensor = resolve(contents, "Resources", "Authenti8MacSensor");
const archive = resolve(release, "Authenti8Verify.zip");
const identity = required("AUTHENTI8_APPLE_SIGNING_IDENTITY");
const notaryProfile = required("AUTHENTI8_NOTARY_PROFILE");

if (process.platform !== "darwin") throw new Error("macOS packaging requires a macOS runner.");
if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("Node 20+ is required.");
rmSync(staging, { recursive: true, force: true }); rmSync(release, { recursive: true, force: true });
mkdirSync(staging, { recursive: true }); mkdirSync(dirname(executable), { recursive: true });
mkdirSync(dirname(sensor), { recursive: true });
execFileSync("/usr/bin/swift", ["build", "--package-path", resolve(root, "native"), "-c", "release"],
  { stdio: "inherit" });
copyFileSync(resolve(root, "native", ".build", "release", "Authenti8MacSensor"), sensor);
await build({ entryPoints: [resolve(root, "src", "cli.ts")], bundle: true, platform: "node",
  format: "cjs", outfile: resolve(staging, "agent.cjs"), define: {
    "import.meta.url": JSON.stringify(new URL(`file://${resolve(root, "src", "sensor.ts")}`).href),
  } });
const seaConfig = resolve(staging, "sea-config.json");
const blob = resolve(staging, "agent.blob");
writeFileSync(seaConfig, JSON.stringify({ main: resolve(staging, "agent.cjs"), output: blob,
  disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });
copyFileSync(process.execPath, executable);
await inject(executable, "NODE_SEA_BLOB", readFileSync(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
});
cpSync(resolve(root, "packaging", "Info.plist"), resolve(contents, "Info.plist"));
sign(sensor); sign(executable); sign(app);
execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, archive], { stdio: "inherit" });
execFileSync("/usr/bin/xcrun", ["notarytool", "submit", archive,
  "--keychain-profile", notaryProfile, "--wait"], { stdio: "inherit" });
execFileSync("/usr/bin/xcrun", ["stapler", "staple", app], { stdio: "inherit" });
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app],
  { stdio: "inherit" });
execFileSync("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", app],
  { stdio: "inherit" });

function sign(path) {
  execFileSync("/usr/bin/codesign", ["--force", "--timestamp", "--options", "runtime",
    "--sign", identity, path], { stdio: "inherit" });
}

function required(name) {
  const value = process.env[name]; if (!value) throw new Error(`${name} is required.`); return value;
}
