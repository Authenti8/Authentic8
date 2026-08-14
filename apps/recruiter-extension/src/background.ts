import { validRecruiterApiPath } from "./index.js";

chrome.alarms.create("authenti8-token-refresh", { periodInMinutes: 5 });

chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  const origin = sender.origin ?? safeOrigin(sender.url);
  if (origin !== "https://authenti8.com" || !isProvisioning(message)) {
    respond({ accepted: false });
    return;
  }
  void chrome.storage.local.set({ extensionToken: message.token,
    apiOrigin: message.apiOrigin ?? "https://authenti8.com/api/v1" })
    .then(() => respond({ accepted: true }), () => respond({ accepted: false }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "authenti8-token-refresh") void refreshToken();
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!isMeetSender(sender) || !isApiRequest(message)) {
    respond({ ok: false, status: 400 });
    return;
  }
  void proxyGet(message.path).then(respond, () => respond({ ok: false, status: 503 }));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (!isMeetSender(port.sender ?? {}) || !validRecruiterApiPath(port.name)) {
    port.disconnect(); return;
  }
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());
  void proxyStream(port.name, controller.signal, (event) => safePost(port, event))
    .catch((error) => safePost(port, { streamError: true,
      status: error instanceof ProxyError ? error.status : 503 }))
    .finally(() => safeDisconnect(port));
});

async function proxyGet(path: string) {
  const { origin, token } = await apiCredentials();
  if (!token) return { ok: false, status: 401 };
  const response = await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000) });
  return { ok: response.ok, status: response.status,
    body: await response.json().catch(() => undefined) };
}

async function refreshToken() {
  const { origin, token } = await apiCredentials();
  if (!token) return;
  try {
    const response = await fetch(`${origin}/recruiter-extension/token/refresh`, { method: "POST",
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) });
    const body = await response.json() as { token?: unknown };
    if (response.ok && typeof body.token === "string") {
      await chrome.storage.local.set({ extensionToken: body.token });
    }
  } catch { /* The next alarm retries transient refresh failures. */ }
}

async function proxyStream(path: string, signal: AbortSignal, send: (event: unknown) => void) {
  const { origin, token } = await apiCredentials();
  if (!token) throw new Error("Extension authentication is unavailable.");
  const response = await fetch(`${origin}${path}`, { headers: {
    accept: "text/event-stream", authorization: `Bearer ${token}` }, signal });
  if (!response.ok || !response.body) throw new ProxyError(response.status);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  while (!signal.aborted) {
    const item = await reader.read();
    if (item.done) break;
    pending += item.value;
    const frames = pending.split("\n\n"); pending = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split("\n").filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim()).join("\n");
      if (data) send(JSON.parse(data) as unknown);
    }
  }
}

async function apiCredentials() {
  const config = await chrome.storage.local.get(["apiOrigin", "extensionToken"]);
  return { token: typeof config.extensionToken === "string" ? config.extensionToken : "",
    origin: config.apiOrigin === "https://authenti8.com/api/v1"
      ? config.apiOrigin : "https://authenti8.com/api/v1" };
}

function safePost(port: ChromePort, value: unknown) {
  try { port.postMessage(value); } catch { /* The Meet tab closed while streaming. */ }
}

function safeDisconnect(port: ChromePort) {
  try { port.disconnect(); } catch { /* The port is already disconnected. */ }
}

function isApiRequest(value: unknown): value is { path: string } {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.type === "AUTHENTI8_API_GET" && typeof item.path === "string"
    && validRecruiterApiPath(item.path);
}

function isMeetSender(sender: { origin?: string; url?: string }) {
  return (sender.origin ?? safeOrigin(sender.url)) === "https://meet.google.com";
}

function safeOrigin(url: string | undefined) {
  try { return url ? new URL(url).origin : undefined; } catch { return undefined; }
}

function isProvisioning(value: unknown): value is { token: string; apiOrigin?: string } {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.token === "string" && /^[A-Za-z0-9_-]{20,}$/.test(item.token)
    && (item.apiOrigin === undefined || item.apiOrigin === "https://authenti8.com/api/v1");
}

class ProxyError extends Error {
  constructor(readonly status: number) { super(`Proxy request failed: ${status}`); }
}
