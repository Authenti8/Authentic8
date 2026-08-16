import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("release-packs", { recursive: true });
writePack("WINDOWS_PACK", "release-packs/windows.json");
writePack("MACOS_PACK", "release-packs/macos.json");

function writePack(name, path) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  const decoded = Buffer.from(value, "base64");
  const parsed = JSON.parse(decoded.toString("utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error(`${name} is invalid.`);
  writeFileSync(path, decoded);
}
