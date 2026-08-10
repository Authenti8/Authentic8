"use client";

import type { CandidateConsentResponse } from "@authenti8/contracts";
import { Check, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import styles from "./verification.module.css";

export function ConsentForm({ token, consentVersion }: {
  token: string;
  consentVersion: string;
}) {
  const [state, setState] = useState<"idle" | "submitting" | "accepted" | "declined">("idle");
  const [error, setError] = useState("");

  async function decide(decision: "ACCEPTED" | "DECLINED") {
    if (state !== "idle") return;
    setState("submitting");
    setError("");
    try {
      const response = await fetch("/api/v1/candidate/verification/consent", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, decision, consentVersion }),
      });
      const result = await response.json() as CandidateConsentResponse & { message?: string };
      if (!response.ok || result.reason) throw new Error(result.message ?? "This link is no longer available.");
      setState(decision === "ACCEPTED" ? "accepted" : "declined");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save your choice.");
      setState("idle");
    }
  }

  if (state === "accepted") return <Outcome accepted />;
  if (state === "declined") return <Outcome accepted={false} />;
  return (
    <div className={styles.consentActions}>
      <button className={styles.consentAccept} disabled={state !== "idle"}
        onClick={() => void decide("ACCEPTED")} type="button">
        {state === "submitting" ? <LoaderCircle className={styles.consentSpin} size={18} />
          : <ShieldCheck size={18} />} Accept and continue
      </button>
      <button className={styles.consentDecline} disabled={state !== "idle"}
        onClick={() => void decide("DECLINED")} type="button">Decline verification</button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

function Outcome({ accepted }: { accepted: boolean }) {
  return <div className={`${styles.consentOutcome} ${accepted ? "" : styles.declined}`}>
    <span>{accepted ? <Check size={22} /> : <X size={22} />}</span>
    <div><strong>{accepted ? "Consent recorded" : "Verification declined"}</strong>
      <p>{accepted ? "Your secure device setup is ready. Keep this page available for the next step."
        : "No monitoring will begin. The hiring team will see that verification was declined."}</p></div>
  </div>;
}
