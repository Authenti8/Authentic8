"use client";

import { useState } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { postJson } from "@/lib/api";

export function CheckoutButton({ purpose, label, quantity = 1 }: {
  purpose: "PROFESSIONAL" | "EXTRA_CREDITS";
  label: string;
  quantity?: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function checkout() {
    setBusy(true);
    setError("");
    try {
      const result = await postJson<{ checkoutUrl: string }>("/billing/checkout", {
        purpose, quantity,
      });
      window.location.assign(result.checkoutUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Checkout could not start.");
      setBusy(false);
    }
  }

  return (
    <div className="checkout-action">
      <button className="button-primary" disabled={busy} onClick={checkout} type="button">
        {busy ? <LoaderCircle className="spin" size={16} /> : null}{label}<ArrowRight size={16} />
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

