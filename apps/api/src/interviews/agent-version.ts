export function isSupportedAgentVersion(platform: "WINDOWS" | "MACOS" | "CHROME", version: string) {
  if (platform === "CHROME") return false;
  const configured = process.env[`${platform}_MINIMUM_AGENT_VERSION`] ?? "0.1.0";
  const actualParts = parse(version);
  const minimumParts = parse(configured);
  if (!actualParts || !minimumParts) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index]! > minimumParts[index]!) return true;
    if (actualParts[index]! < minimumParts[index]!) return false;
  }
  return !version.includes("-") || configured.includes("-");
}

function parse(value: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return undefined;
  const parts = match.slice(1, 4).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}
