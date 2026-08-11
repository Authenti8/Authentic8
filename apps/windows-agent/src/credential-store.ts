import { createHash } from "node:crypto";
import { runSensor } from "./powershell.js";
import type { EnrolledIdentity, PendingEnrollment } from "./types.js";

export async function loadIdentity(enrollmentToken: string) {
  const [result] = await runSensor<LoadResult>("credential-store.ps1", [
    "load", credentialKey(enrollmentToken),
  ]);
  return result?.found && validIdentity(result.identity) ? result.identity : undefined;
}

export async function saveIdentity(enrollmentToken: string, identity: EnrolledIdentity) {
  const encoded = Buffer.from(JSON.stringify(identity)).toString("base64");
  await runSensor("credential-store.ps1", ["save", credentialKey(enrollmentToken), encoded]);
}

export async function loadPendingEnrollment(enrollmentToken: string) {
  const [result] = await runSensor<LoadResult>("credential-store.ps1", [
    "load", credentialKey(enrollmentToken),
  ]);
  return result?.found && validPending(result.identity) ? result.identity : undefined;
}

export async function savePendingEnrollment(
  enrollmentToken: string, pending: PendingEnrollment,
) {
  const encoded = Buffer.from(JSON.stringify(pending)).toString("base64");
  await runSensor("credential-store.ps1", ["save", credentialKey(enrollmentToken), encoded]);
}

export async function removeIdentity(enrollmentToken: string) {
  await runSensor("credential-store.ps1", ["remove", credentialKey(enrollmentToken)]);
}

function credentialKey(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function validIdentity(value?: EnrolledIdentity | PendingEnrollment): value is EnrolledIdentity {
  return Boolean(value && "deviceId" in value && value.deviceId
    && value.verificationSessionId && value.privateKey
    && Number.isFinite(Date.parse(value.eligibleStart)) && Number.isFinite(Date.parse(value.eligibleEnd))
    && Date.parse(value.eligibleEnd) > Date.now());
}

function validPending(value?: EnrolledIdentity | PendingEnrollment): value is PendingEnrollment {
  return Boolean(value && "publicKey" in value && value.publicKey && value.privateKey
    && value.challengeSignature && Number.isFinite(Date.parse(value.challengeExpiresAt)));
}

type LoadResult = { found?: boolean; identity?: EnrolledIdentity | PendingEnrollment };
