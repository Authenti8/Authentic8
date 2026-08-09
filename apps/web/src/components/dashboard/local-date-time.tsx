"use client";

import { useSyncExternalStore } from "react";

type Display = "date-time" | "day" | "month" | "last-sync";

export function LocalDateTime({ value, display }: { value: string; display: Display }) {
  const hydrated = useSyncExternalStore(emptySubscribe, clientSnapshot, serverSnapshot);
  const label = hydrated ? formatDate(value, display) : "—";

  return <time dateTime={value}>{label}</time>;
}

function emptySubscribe() {
  return () => undefined;
}

function clientSnapshot() {
  return true;
}

function serverSnapshot() {
  return false;
}

function formatDate(value: string, display: Display) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  if (display === "day") return date.toLocaleDateString(undefined, { day: "2-digit" });
  if (display === "month") return date.toLocaleDateString(undefined, { month: "short" });
  const formatted = date.toLocaleString();
  return display === "last-sync" ? `Last synced ${formatted}` : formatted;
}
