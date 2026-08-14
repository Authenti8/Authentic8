export const recruiterExtensionProtocol = { consumer: "recruiter-extension", version: 1 } as const;

export function parseMeetCode(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "meet.google.com") return undefined;
    const code = parsed.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    return code && /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code) ? code : undefined;
  } catch { return undefined; }
}

export type RecruiterLog = { sequence: number; kind: PanelStatus; message: string;
  occurredAt: string; metadata: Record<string, unknown> };
export type PanelStatus = "WAITING_FOR_CANDIDATE" | "CONSENT_PENDING" | "DEVICE_CONNECTING"
  | "MONITORING_ACTIVE" | "CONFIRMED_DETECTION" | "MONITORING_INTERRUPTED"
  | "MONITORING_RESUMED" | "MEETING_COMPLETED" | "RECONNECTING";

export function mergeLogs(current: readonly RecruiterLog[], incoming: readonly RecruiterLog[]) {
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  for (const event of incoming) if (validLog(event)) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((left, right) =>
    Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.sequence - right.sequence);
}

export function latestSequence(logs: readonly RecruiterLog[], fallback = 0) {
  return logs.reduce((latest, event) => Math.max(latest, event.sequence), fallback);
}

export function validLog(value: RecruiterLog) {
  return Number.isSafeInteger(value.sequence) && value.sequence > 0 && typeof value.message === "string"
    && value.message.length > 0 && Number.isFinite(Date.parse(value.occurredAt));
}

export function validRecruiterApiPath(path: string) {
  return /^\/recruiter-extension\/meetings\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(path)
    || /^\/recruiter-extension\/interviews\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/logs\?after=\d+$/i
      .test(path)
    || /^\/recruiter-extension\/interviews\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/events\?after=\d+$/i
      .test(path);
}
