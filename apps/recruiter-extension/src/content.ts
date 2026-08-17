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
  root.innerHTML = `<style>${styles}</style><section aria-label="Authenti8 live integrity timeline">
    <header title="Drag to reposition"><div class="brand"><i></i><b>Protected by Authenti8</b></div>
      <span></span><button type="button" aria-label="Minimize integrity timeline">−</button></header>
    <main><div class="candidate"><h3></h3><small></small></div>
      <ol aria-live="polite" aria-relevant="additions"></ol></main></section>`;
  const section = root.querySelector("section") as HTMLElement;
  const header = root.querySelector("header") as HTMLElement;
  const main = root.querySelector("main") as HTMLElement;
  const list = root.querySelector("ol") as HTMLOListElement;
  const button = root.querySelector("button") as HTMLButtonElement;
  const items = new Map<number, HTMLLIElement>();
  root.querySelector("h3")!.textContent = meeting.candidateName || "Candidate";
  root.querySelector("small")!.textContent = meeting.platform ? `Platform: ${meeting.platform}` : "Device pending";
  button.addEventListener("click", () => setMinimized(section, main, button,
    !section.classList.contains("minimized")));
  const stopDragging = makeDraggable(section, header);
  void restorePanelState(section, main, button);
  return { remove: () => { stopDragging(); host.remove(); },
    render(logs: readonly RecruiterLog[], status: PanelStatus) {
    root.querySelector("span")!.textContent = status.replaceAll("_", " ");
    const active = new Set(logs.map((event) => event.sequence));
    for (const [sequence, item] of items) if (!active.has(sequence)) {
      item.remove(); items.delete(sequence);
    }
    let added = false;
    for (const event of logs) {
      let item = items.get(event.sequence);
      if (!item) { item = renderLog(event); items.set(event.sequence, item); added = true; }
      list.append(item);
    }
    if (added) requestAnimationFrame(() => list.scrollTo({ top: list.scrollHeight,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
  } };
}

function renderLog(event: RecruiterLog) {
  const item = document.createElement("li");
  const message = document.createElement("strong");
  const time = document.createElement("time");
  message.textContent = event.message;
  time.dateTime = event.occurredAt;
  time.textContent = new Date(event.occurredAt).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit" });
  item.append(message, time);
  if (event.kind === "CONFIRMED_DETECTION") item.className = "danger";
  else if (event.kind === "MONITORING_INTERRUPTED" || event.kind === "RECONNECTING")
    item.className = "warning";
  return item;
}

function makeDraggable(panel: HTMLElement, handle: HTMLElement) {
  let offsetX = 0; let offsetY = 0; let dragging = false;
  handle.addEventListener("pointerdown", (event) => {
    if ((event.target as Element).closest("button")) return;
    const bounds = panel.getBoundingClientRect();
    offsetX = event.clientX - bounds.left; offsetY = event.clientY - bounds.top;
    dragging = true; panel.classList.add("dragging");
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!dragging || !handle.hasPointerCapture(event.pointerId)) return;
    positionPanel(panel, event.clientX - offsetX, event.clientY - offsetY);
  });
  const finish = () => { if (!dragging) return; dragging = false;
    panel.classList.remove("dragging"); void persistPanelState(panel); };
  handle.addEventListener("pointerup", finish); handle.addEventListener("pointercancel", finish);
  const resize = () => { const bounds = panel.getBoundingClientRect();
    positionPanel(panel, bounds.left, bounds.top); };
  addEventListener("resize", resize);
  return () => removeEventListener("resize", resize);
}

const panelStateKey = "authenti8:recruiter-panel-state";
function positionPanel(panel: HTMLElement, left: number, top: number) {
  const edge = 12;
  const x = Math.min(Math.max(edge, left), Math.max(edge, innerWidth - panel.offsetWidth - edge));
  const y = Math.min(Math.max(edge, top), Math.max(edge, innerHeight - panel.offsetHeight - edge));
  panel.style.left = `${x}px`; panel.style.top = `${y}px`; panel.style.right = "auto";
}
async function persistPanelState(panel: HTMLElement) {
  const bounds = panel.getBoundingClientRect();
  await chrome.storage.local.set({ [panelStateKey]: { left: bounds.left, top: bounds.top,
    minimized: panel.classList.contains("minimized") } }).catch(() => undefined);
}
async function restorePanelState(panel: HTMLElement, main: HTMLElement, button: HTMLButtonElement) {
  const stored: Record<string, unknown> = await chrome.storage.local.get([panelStateKey])
    .catch(() => ({}));
  const state = stored[panelStateKey];
  if (!record(state)) return;
  if (typeof state.left === "number" && typeof state.top === "number")
    positionPanel(panel, state.left, state.top);
  if (state.minimized === true) setMinimized(panel, main, button, true, false);
}
function setMinimized(panel: HTMLElement, main: HTMLElement, button: HTMLButtonElement,
  minimized: boolean, save = true) {
  panel.classList.toggle("minimized", minimized); main.hidden = minimized;
  button.textContent = minimized ? "+" : "−";
  button.setAttribute("aria-label", `${minimized ? "Expand" : "Minimize"} integrity timeline`);
  const bounds = panel.getBoundingClientRect();
  positionPanel(panel, bounds.left, bounds.top);
  if (save) void persistPanelState(panel);
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
const styles = `:host{all:initial}section{position:fixed;z-index:2147483647;right:24px;top:90px;width:min(430px,calc(100vw - 24px));
color:#fff;font:14px Inter,ui-sans-serif,system-ui,sans-serif;pointer-events:none;filter:drop-shadow(0 18px 28px #0007)}
header{width:max-content;max-width:100%;margin-left:auto;display:flex;gap:10px;align-items:center;padding:7px 8px 7px 12px;cursor:grab;
pointer-events:auto;background:#111827e8;border:1px solid #ffffff24;border-radius:999px;user-select:none;touch-action:none}
.dragging header{cursor:grabbing}.brand{display:flex;align-items:center;gap:7px;color:#b7f7d8;text-transform:uppercase;font-size:11px;letter-spacing:.035em}
.brand i{width:8px;height:8px;border-radius:50%;background:#24d397;box-shadow:0 0 0 6px #1677ff22}.brand b{white-space:nowrap}
header span{font-size:10px;color:#cbd5e1;white-space:nowrap}button{display:grid;place-items:center;width:28px;height:28px;padding:0;color:#fff;
background:#ffffff12;border:1px solid #ffffff1f;border-radius:50%;font:18px/1 system-ui;cursor:pointer}button:hover{background:#ffffff24}
main{margin-top:9px}.candidate{width:max-content;max-width:calc(100% - 20px);margin:0 8px 8px auto;padding:6px 11px;text-align:right;
background:#111827c7;border:1px solid #ffffff1c;border-radius:10px;backdrop-filter:blur(10px)}h3{display:inline;margin:0;font-size:12px}
small{margin-left:8px;color:#aeb9ca;font-size:10px}ol{display:flex;flex-direction:column;gap:9px;list-style:none;padding:0 4px 8px;margin:0;
max-height:min(58vh,440px);overflow:auto;pointer-events:none;scrollbar-width:none}ol::-webkit-scrollbar{display:none}
li{box-sizing:border-box;min-height:62px;padding:14px 17px;display:flex;align-items:center;justify-content:space-between;gap:14px;
background:#373f46e8;border:1px solid #ffffff38;border-radius:16px;box-shadow:0 12px 28px #0004;backdrop-filter:blur(12px);
animation:log-enter 620ms cubic-bezier(.18,.86,.32,1.12) both}li:nth-child(odd){background:#52595eee}li strong{font-size:15px;font-weight:520;line-height:1.3}
time{flex:none;color:#e5e7eb;font:10px ui-monospace,SFMono-Regular,Consolas,monospace}.warning{background:#67512fed!important;border-color:#f6c45388}
.danger{background:#6e3337f2!important;border-color:#df888e;color:#fff}.minimized{width:auto;filter:drop-shadow(0 8px 18px #0006)}[hidden]{display:none}
@keyframes log-enter{from{opacity:0;filter:blur(5px);transform:translateY(13px) scale(.96)}to{opacity:1;filter:blur(0);transform:none}}
@media(max-width:600px){section{right:12px;top:72px}header span{display:none}li{min-height:54px;padding:12px 14px}}
@media(prefers-reduced-motion:reduce){li{animation:none}ol{scroll-behavior:auto}}`;
