import { runSensor } from "./powershell.js";

export async function verifyInstalledSignature(executablePath = process.execPath) {
  const results = await runSensor<SignatureResult>("signature-check.ps1", [executablePath]);
  const result = results.find((entry) => entry.path.toLowerCase() === executablePath.toLowerCase());
  if (!result || result.status !== "Valid" || !result.signerThumbprint
    || !/(?:^|,\s*)O=Authenti8(?:,|$)/i.test(result.signerSubject ?? "")) {
    throw new Error("Authenti8 Verify code signature is not valid.");
  }
  return result;
}

type SignatureResult = { path: string; status: string; signerThumbprint?: string; signerSubject?: string };
