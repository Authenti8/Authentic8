let generation = 0;
let currentCode: string | undefined;
let stopped = false;
void monitorLocation();

async function monitorLocation() {
  addEventListener("pagehide", () => { stopped = true; generation += 1; }, { once: true });
  while (!stopped) {
    const nextCode = parseMeetCode(location.href);
    if (nextCode !== currentCode) {
      currentCode = nextCode;
      generation += 1;
      document.getElementById("authenti8-recruiter-panel")?.remove();
      if (nextCode) void start(nextCode, generation);
    }
    await delay(500);
  }
}

async function start(meetCode: string, run: number) {
  const meeting = await discoverMeeting(meetCode, run);
  if (!meeting?.interviewId || run !== generation) return;
  const panel = createPanel(meeting);
  let logs: RecruiterLog[] = [];
  // Always hydrate the backend-authored timeline. The stored cursor is a recovery checkpoint,
  // not a substitute for the events needed to render after a page refresh.
  let cursor = 0;
  while (!stopped && run === generation) {
    try {
      const result = await request<{ events: RecruiterLog[] }>(
        `/recruiter-extension/interviews/${meeting.interviewId}/logs?after=${cursor}`);
      logs = mergeLogs(logs, result?.events ?? []);
      cursor = latestSequence(logs, cursor);
      panel.render(logs, logs.at(-1)?.kind ?? statusOf(meeting.status));
      await streamLogs(meeting.interviewId, cursor, run, (event) => {
        logs = mergeLogs(logs, [event]); cursor = latestSequence(logs, cursor);
        void chrome.storage.local.set({ [`cursor:${meetCode}`]: cursor });
        panel.render(logs, logs.at(-1)?.kind ?? statusOf(meeting.status));
      });
    } catch (error) {
      if (authorizationFailure(error)) {
        panel.remove();
        currentCode = undefined;
        return;
      }
      panel.render(logs, "RECONNECTING"); await delay(1_000);
    }
  }
}

function streamLogs(interviewId: string, cursor: number, run: number,
  receive: (event: RecruiterLog) => void) {
  return new Promise<void>((resolve, reject) => {
    const path = `/recruiter-extension/interviews/${interviewId}/events?after=${cursor}`;
    const port = chrome.runtime.connect({ name: path });
    const watch = setInterval(() => {
      if (stopped || run !== generation) { clearInterval(watch); port.disconnect(); resolve(); }
    }, 500);
    port.onMessage.addListener((value) => {
      if (record(value) && value.streamError === true) {
        clearInterval(watch); reject(new ProxyError(Number(value.status)));
      }
      else if (validLog(value as RecruiterLog)) receive(value as RecruiterLog);
    });
    port.onDisconnect.addListener(() => { clearInterval(watch);
      if (!stopped && run === generation) reject(new Error("Stream disconnected.")); else resolve(); });
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function discoverMeeting(meetCode: string, run: number) {
  while (!stopped && run === generation) {
    try {
      const meeting = await request<Meeting>(`/recruiter-extension/meetings/${meetCode}`);
      if (meeting.protected && meeting.interviewId) return meeting;
    } catch { /* Provisioning and transient network failures are retried. */ }
    await delay(2_000);
  }
  return undefined;
}

async function request<T>(path: string) {
  const response = (await chrome.runtime.sendMessage(
    { type: "AUTHENTI8_API_GET", path })) as ProxyResponse<T>;
  if (!response?.ok) throw new ProxyError(response?.status ?? 503);
  return response.body as T;
}

function createPanel(meeting: Meeting) {
  const host = document.createElement("aside");
  host.id = "authenti8-recruiter-panel";
  document.documentElement.append(host);
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>${styles}</style><section><header><b>Authenti8</b><span></span><button>−</button></header>
    <main><h3></h3><small></small><ol></ol></main></section>`;
  const section = root.querySelector("section") as HTMLElement;
  const header = root.querySelector("header") as HTMLElement;
  const main = root.querySelector("main") as HTMLElement;
  root.querySelector("h3")!.textContent = meeting.candidateName || "Candidate";
  root.querySelector("small")!.textContent = meeting.platform ? `Platform: ${meeting.platform}` : "Device pending";
  root.querySelector("button")!.addEventListener("click", () => main.toggleAttribute("hidden"));
  makeDraggable(section, header);
  return { remove: () => host.remove(), render(logs: readonly RecruiterLog[], status: PanelStatus) {
    root.querySelector("span")!.textContent = status.replaceAll("_", " ");
    root.querySelector("ol")!.replaceChildren(...logs.map(renderLog));
  } };
}

function renderLog(event: RecruiterLog) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date(event.occurredAt).toLocaleTimeString();
  item.textContent = event.message;
  item.prepend(time);
  if (event.kind === "CONFIRMED_DETECTION") item.className = "danger";
  return item;
}

function makeDraggable(panel: HTMLElement, handle: HTMLElement) {
  let offsetX = 0; let offsetY = 0;
  handle.addEventListener("pointerdown", (event) => {
    offsetX = event.clientX - panel.offsetLeft; offsetY = event.clientY - panel.offsetTop;
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    panel.style.left = `${Math.max(0, event.clientX - offsetX)}px`;
    panel.style.top = `${Math.max(0, event.clientY - offsetY)}px`; panel.style.right = "auto";
  });
}

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function authorizationFailure(error: unknown) {
  return error instanceof ProxyError && (error.status === 401 || error.status === 403);
}
function statusOf(value?: string): PanelStatus {
  return value === "MONITORING_ACTIVE" ? "MONITORING_ACTIVE" : "WAITING_FOR_CANDIDATE";
}
type Meeting = { protected: boolean; interviewId?: string; candidateName?: string;
  platform?: string; status?: string };
type ProxyResponse<T> = { ok: boolean; status: number; body?: T };
type RecruiterLog = { sequence: number; kind: PanelStatus; message: string;
  occurredAt: string; metadata: Record<string, unknown> };
type PanelStatus = "WAITING_FOR_CANDIDATE" | "CONSENT_PENDING" | "DEVICE_CONNECTING"
  | "MONITORING_ACTIVE" | "CONFIRMED_DETECTION" | "MONITORING_INTERRUPTED"
  | "MONITORING_RESUMED" | "MEETING_COMPLETED" | "RECONNECTING";

function parseMeetCode(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "meet.google.com") return undefined;
    const value = parsed.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    return value && /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(value) ? value : undefined;
  } catch { return undefined; }
}

function mergeLogs(current: readonly RecruiterLog[], incoming: readonly RecruiterLog[]) {
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  for (const event of incoming) if (validLog(event)) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((left, right) =>
    Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.sequence - right.sequence);
}

function latestSequence(logs: readonly RecruiterLog[], fallback = 0) {
  return logs.reduce((latest, event) => Math.max(latest, event.sequence), fallback);
}

function validLog(value: RecruiterLog) {
  return Number.isSafeInteger(value.sequence) && value.sequence > 0
    && typeof value.message === "string" && value.message.length > 0
    && Number.isFinite(Date.parse(value.occurredAt));
}
class ProxyError extends Error {
  constructor(readonly status: number) { super(`Proxy request failed: ${status}`); }
}
const styles = `:host{all:initial}section{position:fixed;z-index:2147483647;right:24px;top:90px;width:390px;
background:#111827;color:#fff;border:1px solid #64748b;border-radius:18px;font:14px system-ui;box-shadow:0 18px 50px #0008}
header{display:flex;gap:12px;align-items:center;padding:16px;cursor:move;border-bottom:1px solid #334155}header b{flex:1}
header span{font-size:11px;color:#6ee7b7}button{color:#fff;background:none;border:0;font-size:20px}main{padding:16px}h3{margin:0 0 4px}
small{color:#94a3b8}ol{list-style:none;padding:0;margin:14px 0 0;max-height:330px;overflow:auto}li{padding:10px;border-top:1px solid #334155}
time{color:#94a3b8;margin-right:10px}.danger{color:#fca5a5}[hidden]{display:none}`;
