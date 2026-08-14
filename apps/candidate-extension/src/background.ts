import { changedExtension, hasRecentProfileProof, matchExtensions,
  validSignatures } from "./browser-monitor.js";
import type { BrowserEvidence, ExtensionDescriptor } from "./browser-monitor.js";

const nativeHost = "com.authenti8.verify";

chrome.runtime.onInstalled.addListener(() => { void synchronize(); });
chrome.alarms.create("authenti8-health", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "authenti8-health") void synchronize();
});
chrome.management.onEnabled.addListener((info) => { void extensionChanged(info); });
chrome.management.onDisabled.addListener((info) => { void extensionChanged(info); });
chrome.runtime.onMessage.addListener((message) => {
  if (record(message) && message.type === "AUTHENTI8_MEET_ACTIVE") void synchronize(true);
});
void synchronize();

async function synchronize(activeProfileVerified = false) {
  const profileVerified = await activeProfileStatus(activeProfileVerified);
  const [extensions, signatures, profileInstanceId] = await Promise.all([
    chrome.management.getAll(), loadSignatures(), profileId(),
  ]);
  const evidence = matchExtensions(extensions.map(descriptor), signatures);
  await sendNative(profileInstanceId, evidence, profileVerified);
}

async function extensionChanged(info: ChromeExtensionInfo) {
  const [signatures, profileInstanceId] = await Promise.all([loadSignatures(), profileId()]);
  const evidence = changedExtension(descriptor(info), signatures);
  if (evidence) await sendNative(profileInstanceId, [evidence], await activeProfileStatus(false));
}

async function activeProfileStatus(provedNow: boolean) {
  if (provedNow) {
    const lastActiveProfileProofAt = Date.now();
    await chrome.storage.session.set({ lastActiveProfileProofAt });
    return true;
  }
  const stored = await chrome.storage.session.get(["lastActiveProfileProofAt"]);
  return hasRecentProfileProof(stored.lastActiveProfileProofAt);
}

async function sendNative(
  profileInstanceId: string, evidence: BrowserEvidence[], activeProfileVerified: boolean,
) {
  return new Promise<void>((resolve) => {
    let settled = false;
    const port = chrome.runtime.connectNative(nativeHost);
    const finish = () => { if (!settled) { settled = true; port.disconnect(); resolve(); } };
    port.onMessage.addListener(finish);
    port.onDisconnect.addListener(finish);
    port.postMessage({ type: "BROWSER_EVIDENCE", requestId: crypto.randomUUID(),
      profileInstanceId, extensionRuntimeId: chrome.runtime.id, activeProfileVerified, evidence });
    setTimeout(finish, 5_000);
  });
}

async function loadSignatures() {
  const managed = await chrome.storage.managed.get(["prohibitedExtensionIds"]);
  return validSignatures(managed.prohibitedExtensionIds);
}

async function profileId() {
  const existing = await chrome.storage.local.get(["profileInstanceId"]);
  if (typeof existing.profileInstanceId === "string") return existing.profileInstanceId;
  const created = crypto.randomUUID();
  await chrome.storage.local.set({ profileInstanceId: created });
  return created;
}

function descriptor(info: ChromeExtensionInfo): ExtensionDescriptor {
  return { id: info.id, version: info.version, enabled: info.enabled, installType: info.installType };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
