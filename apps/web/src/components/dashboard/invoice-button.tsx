"use client";

import { Download, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { getJson } from "@/lib/api";

export function InvoiceButton({ paymentId }: { paymentId: string }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function download() {
    setBusy(true); setError("");
    try {
      const result = await getJson<{ invoiceUrl: string }>(
        `/billing/payments/${encodeURIComponent(paymentId)}/invoice`,
      );
      window.location.assign(result.invoiceUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Invoice could not open."); setBusy(false);
    }
  }
  return <span className="invoice-download"><button aria-label="Download invoice" disabled={busy}
    onClick={download} type="button">{busy ? <LoaderCircle className="spin" size={15} />
      : <Download size={15} />}</button>{error ? <small role="alert">{error}</small> : null}</span>;
}
