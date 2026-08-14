import { changedExtension, hasRecentProfileProof, matchExtensions,
  validSignatures } from "./browser-monitor.js";
import type { BrowserEvidence, ExtensionDescriptor } from "./browser-monitor.js";
import { loadChromeRulePack, verifyChromeRulePack } from "./chrome-rule-pack.js";

const nativeHost = "com.authenti8.verify";

chrome.runtime.onInstalled.addListener(() => { void synchronize(); });
chrome.alarms.create("authenti8-health", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "authenti8-health") void synchronize();
});
chrome.management.onEnabled.addListener((info) => { void extensionChanged(info); });
chrome.management.onDisabled.addListener((info) => { void extensionChanged(info); });
chrome.management.onInstalled.addListener((info) => { void extensionChanged(info); });
chrome.runtime.onMessage.addListener((message) => {
  if (record(message) && message.type === "AUTHENTI8_MEET_ACTIVE") void synchronize(true);
});
void synchronize();

async function synchronize(activeProfileVerified = false) {
  const profileVerified = await activeProfileStatus(activeProfileVerified);
  const [extensions, pack, profileInstanceId] = await Promise.all([
    chrome.management.getAll(), loadSignatures(), profileId(),
  ]);
  const evidence = matchExtensions(extensions.map(descriptor), pack.signatures);
  await sendNative(profileInstanceId, evidence, profileVerified, pack.verified);
}

async function extensionChanged(info: ChromeExtensionInfo) {
  const [pack, profileInstanceId] = await Promise.all([loadSignatures(), profileId()]);
  const evidence = changedExtension(descriptor(info), pack.signatures);
  if (evidence) await sendNative(profileInstanceId, [evidence], await activeProfileStatus(false),
    pack.verified);
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
  rulePackVerified: boolean,
) {
  return new Promise<void>((resolve) => {
    let settled = false;
    const port = chrome.runtime.connectNative(nativeHost);
    const finish = () => { if (!settled) { settled = true; port.disconnect(); resolve(); } };
    port.onMessage.addListener(finish);
    port.onDisconnect.addListener(finish);
    port.postMessage({ type: "BROWSER_EVIDENCE", requestId: crypto.randomUUID(),
      profileInstanceId, extensionRuntimeId: chrome.runtime.id, activeProfileVerified,
      rulePackVerified, evidence });
    setTimeout(finish, 5_000);
  });
}

async function loadSignatures() {
  const [managed, local] = await Promise.all([
    chrome.storage.managed.get(["rulePackPublicKey"]),
    chrome.storage.local.get(["verifiedChromeRulePack"]),
  ]);
  try {
    const loaded = await loadChromeRulePack("https://authenti8.com/api/v1/agent/rules/chrome",
      managed.rulePackPublicKey);
    void chrome.storage.local.set({ verifiedChromeRulePack: loaded.signedPack })
      .catch(() => undefined);
    return { signatures: validSignatures(loaded.signatures), verified: true };
  } catch {
    try {
      if (typeof managed.rulePackPublicKey !== "string") throw new Error("Missing key");
      const cached = await verifyChromeRulePack(local.verifiedChromeRulePack,
        managed.rulePackPublicKey);
      return { signatures: validSignatures(cached), verified: true };
    } catch { return { signatures: validSignatures(undefined), verified: false }; }
  }
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
