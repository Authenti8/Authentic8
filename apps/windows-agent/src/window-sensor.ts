import { createHash } from "node:crypto";
import type { WindowEvidence } from "@authenti8/event-schemas";
import { runSensor } from "./powershell.js";

export async function collectWindows() {
  const rows = await runSensor<WindowRow>("window-sensor.ps1");
  return rows.map(normalizeWindow).filter((row): row is WindowEvidence => Boolean(row));
}

function normalizeWindow(row: WindowRow): WindowEvidence | undefined {
  if (!row.handle || !Number.isInteger(row.ownerProcessId) || !validBounds(row.bounds)) return undefined;
  return { windowIdHash: hash(row.handle), ownerProcessId: row.ownerProcessId,
    visible: Boolean(row.visible), topmost: Boolean(row.topmost), layered: Boolean(row.layered),
    transparent: Boolean(row.transparent), captureExcluded: Boolean(row.captureExcluded),
    titleHash: hash(row.title ?? ""), classHash: hash(row.className ?? ""), bounds: row.bounds };
}

function validBounds(value?: WindowRow["bounds"]): value is WindowEvidence["bounds"] {
  return Boolean(value && [value.left, value.top, value.width, value.height].every(Number.isFinite));
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

type WindowRow = { handle: string; ownerProcessId: number; visible?: boolean; topmost?: boolean;
  layered?: boolean; transparent?: boolean; captureExcluded?: boolean; title?: string;
  className?: string; bounds?: { left: number; top: number; width: number; height: number } };
