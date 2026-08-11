import type { AudioEndpointEvidence, ProcessEvidence, WindowEvidence } from "@authenti8/event-schemas";

export function processChanges(previous: ProcessEvidence[], current: ProcessEvidence[]) {
  const before = new Map(previous.map((item) => [item.processId, item]));
  const after = new Map(current.map((item) => [item.processId, item]));
  const changes = current.filter((item) => changed(before.get(item.processId), item));
  for (const [processId, item] of before) {
    if (!after.has(processId)) changes.push({ ...item, change: "STOPPED" });
  }
  return changes;
}

export function windowChanges(previous: WindowEvidence[], current: WindowEvidence[]) {
  const before = new Map(previous.map((item) => [item.windowIdHash, fingerprint(item)]));
  return current.filter((item) => before.get(item.windowIdHash) !== fingerprint(item));
}

export function audioChanges(
  previous: AudioEndpointEvidence[], current: AudioEndpointEvidence[], baseline = false,
) {
  const before = new Map(previous.map((item) => [item.endpointIdHash, item]));
  const after = new Map(current.map((item) => [item.endpointIdHash, item]));
  const changes: AudioEndpointEvidence[] = current
    .filter((item) => changed(before.get(item.endpointIdHash), item))
    .map((item) => ({ ...item, change: baseline ? "BASELINE" as const : audioChange(before.get(item.endpointIdHash), item) }));
  for (const [id, item] of before) {
    if (!after.has(id)) changes.push({ ...item, change: "REMOVED" });
  }
  return changes;
}

function audioChange(previous: AudioEndpointEvidence | undefined, current: AudioEndpointEvidence) {
  if (!previous) return "ADDED" as const;
  if (previous.isDefaultCommunications !== current.isDefaultCommunications) return "DEFAULT_CHANGED" as const;
  return "CHANGED" as const;
}

function changed<T>(previous: T | undefined, current: T) {
  return !previous || JSON.stringify(previous) !== JSON.stringify(current);
}

function fingerprint(value: object) {
  return JSON.stringify(value);
}
