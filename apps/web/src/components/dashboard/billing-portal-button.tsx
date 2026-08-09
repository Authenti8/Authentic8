"use client";

import { useState } from "react";
import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { postJson } from "@/lib/api";

export function BillingPortalButton({ label }: { label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function openPortal() {
    setBusy(true);
    setError("");
    try {
      const result = await postJson<{ portalUrl: string }>("/billing/portal", {});
      window.location.assign(result.portalUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Billing management could not open.");
      setBusy(false);
    }
  }

  return (
    <div className="checkout-action">
      <button className="button-primary" disabled={busy} onClick={openPortal} type="button">
        {busy ? <LoaderCircle className="spin" size={16} /> : null}{label}
        <ArrowUpRight size={16} />
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
