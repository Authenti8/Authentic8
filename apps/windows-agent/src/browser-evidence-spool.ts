import type { TelemetryEventType } from "@authenti8/event-schemas";
import { runSensor } from "./powershell.js";

const allowedEvents = new Set<TelemetryEventType>([
  "BROWSER_EXTENSION_MATCH", "BROWSER_EXTENSION_CHANGED", "BROWSER_PROFILE_HEALTH",
]);

export type SpooledBrowserEvidence = { eventType: TelemetryEventType;
  payload: Readonly<Record<string, unknown>> };

export async function enqueueBrowserEvidence(request: NativeRequest) {
  const profile = request.profileInstanceId ?? "";
  const runtime = request.extensionRuntimeId ?? "";
  if (!uuid(profile) || !/^[a-p]{32}$/.test(runtime) || !Array.isArray(request.evidence)
    || request.evidence.length > 50) return false;
  const normalized = request.evidence.map(validEvidence);
  if (normalized.some((item) => !item)) return false;
  const health = { eventType: "BROWSER_PROFILE_HEALTH", payload: {
    profileInstanceId: profile, nativeHostConnected: true,
    activeProfileVerified: request.activeProfileVerified === true,
    ...(request.activeProfileVerified === true ? {} : { reason: "PROFILE_MISMATCH" }),
  } } satisfies SpooledBrowserEvidence;
  const encoded = Buffer.from(JSON.stringify([health, ...normalized])).toString("base64");
  if (encoded.length > 80 * 1024) return false;
  const [result] = await runSensor<{ saved?: boolean }>("browser-evidence-store.ps1",
    ["enqueue", encoded]);
  return result?.saved === true;
}

export async function claimBrowserEvidence() {
  const [result] = await runSensor<{ claimId?: string; evidence?: unknown[] }>(
    "browser-evidence-store.ps1", ["claim"]);
  if (!uuid(result?.claimId ?? "")) return undefined;
  const evidence = (result?.evidence ?? []).map(validEvidence).filter(Boolean) as
    SpooledBrowserEvidence[];
  return { claimId: result!.claimId!, evidence };
}

export async function acknowledgeBrowserEvidence(claimId: string) {
  if (!uuid(claimId)) return false;
  const [result] = await runSensor<{ acknowledged?: boolean }>(
    "browser-evidence-store.ps1", ["ack", claimId]);
  return result?.acknowledged === true;
}

function validEvidence(value: unknown): SpooledBrowserEvidence | undefined {
  if (!record(value) || typeof value.eventType !== "string"
    || !allowedEvents.has(value.eventType as TelemetryEventType) || !record(value.payload)) return;
  const payload = value.payload;
  if (value.eventType === "BROWSER_PROFILE_HEALTH") {
    if (!uuid(String(payload.profileInstanceId ?? ""))) return;
    return { eventType: "BROWSER_PROFILE_HEALTH", payload: {
      profileInstanceId: payload.profileInstanceId,
      nativeHostConnected: payload.nativeHostConnected === true,
      activeProfileVerified: payload.activeProfileVerified === true } };
  }
  if (!/^[a-p]{32}$/.test(String(payload.extensionId ?? ""))
    || !/^[A-Za-z0-9._-]{1,100}$/.test(String(payload.ruleKey ?? ""))) return;
  return { eventType: value.eventType as TelemetryEventType, payload: {
    extensionId: payload.extensionId, version: String(payload.version ?? "UNKNOWN").slice(0, 50),
    enabled: payload.enabled === true, installationType: payload.installationType,
    ruleKey: payload.ruleKey } };
}

function uuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

type NativeRequest = { profileInstanceId?: string; extensionRuntimeId?: string;
  activeProfileVerified?: boolean; evidence?: unknown };
