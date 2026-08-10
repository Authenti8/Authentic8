"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "../../lib/api";

export function WorkspaceWarning({ message, dismissible }: {
  message: string;
  dismissible: boolean;
}) {
  const router = useRouter();
  const [hidden, setHidden] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  if (hidden) return null;
  async function dismiss() {
    setPending(true);
    setError(false);
    try {
      await postJson<{ acknowledged: number }>("/notifications/acknowledge", {});
      setHidden(true);
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }
  return <div className="workspace-warning"><span>{error ?
    "Could not dismiss the alert. Please try again." : message}</span>{dismissible ?
    <button type="button" disabled={pending} onClick={() => void dismiss()}>
      {pending ? "Dismissing…" : "Dismiss"}
    </button> : null}</div>;
}
