"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoaderCircle, RefreshCw, Unplug } from "lucide-react";
import { postJson } from "@/lib/api";

export function IntegrationActions({ connected, canManage }: {
  connected: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"sync" | "disconnect" | null>(null);
  const [error, setError] = useState("");
  if (!canManage) return <span className="plan-note">Owner or admin access is required.</span>;
  if (!connected) return <button className="button-primary" onClick={() => {
    const connectUrl = new URL("/api/v1/integrations/google/connect", window.location.origin);
    window.location.assign(connectUrl.toString());
  }} type="button">Connect Google Calendar</button>;

  async function act(action: "sync" | "disconnect") {
    setBusy(action);
    setError("");
    try {
      await postJson(`/integrations/google/${action}`, {});
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Integration action failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="integration-actions">
      <button className="button-secondary" disabled={Boolean(busy)} onClick={() => act("sync")} type="button">{busy === "sync" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Sync now</button>
      <button className="button-quiet" disabled={Boolean(busy)} onClick={() => act("disconnect")} type="button"><Unplug size={14} /> Disconnect</button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
