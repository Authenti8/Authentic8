"use client";

import { ArrowRight, CheckCircle2 } from "lucide-react";
import { useState, type FormEvent } from "react";

export function LeadForm() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    if (values.get("website")) { setMessage("Thank you. Your request has been received."); return; }
    setPending(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/v1/commercial/leads", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ leadType: "WAITLIST", fullName: values.get("fullName"),
          email: values.get("email"), companyName: values.get("companyName"),
          sourcePath: window.location.pathname, referrer: document.referrer || undefined,
          attribution: attribution() }),
      });
      const body = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? "We could not submit your request.");
      setMessage(body.message ?? "Thank you. Your request has been received.");
      form.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "We could not submit your request.");
    } finally { setPending(false); }
  }

  return <form className="lead-form" onSubmit={submit}>
    <div className="lead-fields">
      <label>Full name<input autoComplete="name" maxLength={100} minLength={2}
        name="fullName" placeholder="Your name" required /></label>
      <label>Work email<input autoComplete="email" maxLength={320} name="email"
        placeholder="you@company.com" required type="email" /></label>
      <label>Company name<input autoComplete="organization" maxLength={160} minLength={2}
        name="companyName" placeholder="Company" required /></label>
      <label className="lead-trap" aria-hidden="true">Website<input name="website" tabIndex={-1} /></label>
    </div>
    <button className="button-primary" disabled={pending} type="submit">
      {pending ? "Submitting…" : "Join the waitlist"}
      {!pending && <ArrowRight size={17} />}
    </button>
    <p className={`lead-message${error ? " is-error" : ""}`} aria-live="polite">
      {message && <CheckCircle2 size={16} />}{error || message}
    </p>
  </form>;
}

function attribution() {
  const query = new URLSearchParams(window.location.search);
  return Object.fromEntries(["utm_source", "utm_medium", "utm_campaign"].flatMap((key) => {
    const value = query.get(key)?.slice(0, 120); return value ? [[key, value]] : [];
  }));
}
