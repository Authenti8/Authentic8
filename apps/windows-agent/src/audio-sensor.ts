import { createHash } from "node:crypto";
import type { AudioEndpointEvidence } from "@authenti8/event-schemas";
import { runSensor } from "./powershell.js";

export async function collectAudioEndpoints() {
  const rows = await runSensor<AudioRow>("audio-sensor.ps1");
  return rows.map(normalizeAudio).filter((row): row is AudioEndpointEvidence => Boolean(row));
}

function normalizeAudio(row: AudioRow): AudioEndpointEvidence | undefined {
  if (!row.id || !row.name || !["CAPTURE", "RENDER"].includes(row.direction)) return undefined;
  if (!states.includes(row.state)) return undefined;
  return { endpointIdHash: createHash("sha256").update(row.id).digest("hex"),
    friendlyName: row.name.slice(0, 300), provider: row.provider?.slice(0, 300),
    direction: row.direction, state: row.state, isDefaultCommunications: Boolean(row.isDefault),
    change: "BASELINE" };
}

const states = ["ACTIVE", "DISABLED", "NOT_PRESENT", "UNPLUGGED"] as const;
type AudioRow = { id: string; name: string; provider?: string; direction: "CAPTURE" | "RENDER";
  state: AudioEndpointEvidence["state"]; isDefault?: boolean };
