"use client";

import { useEffect } from "react";
import { postJson } from "@/lib/api";

export function RecruiterExtensionBridge({ extensionId, organizationId }:
  { extensionId?: string; organizationId: string }) {
  useEffect(() => {
    const runtime = window.chrome?.runtime;
    if (!extensionId || !/^[a-p]{32}$/.test(extensionId) || !runtime) return;
    let active = true;
    const provision = async () => {
      try {
        const issued = await postJson<{ token: string }>("/recruiter-extension/token",
          { organizationId });
        if (!active) return;
        runtime.sendMessage(extensionId, { token: issued.token }, () => {
          void runtime.lastError;
        });
      } catch { /* The extension can be absent without affecting the dashboard. */ }
    };
    void provision();
    const timer = window.setInterval(() => { void provision(); }, 10 * 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [extensionId, organizationId]);
  return null;
}

declare global {
  interface Window {
    chrome?: { runtime?: { lastError?: unknown; sendMessage(extensionId: string, message: unknown,
      callback: () => void): void } };
  }
}
