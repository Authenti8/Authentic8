"use client";

import type { CandidateVerification } from "@authenti8/contracts";
import { CalendarClock, Eye, FileX, LockKeyhole, MonitorCheck, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Brand } from "@/components/brand";
import { ConsentForm } from "./[token]/consent-form";
import styles from "./[token]/verification.module.css";

export function CandidateVerificationPortal() {
  const started = useRef(false);
  const [token, setToken] = useState("");
  const [verification, setVerification] = useState<CandidateVerification>();
  const [error, setError] = useState("");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void initialize();

    async function initialize() {
      await Promise.resolve();
      const candidateToken = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(candidateToken)) {
        setError("This verification link is invalid or incomplete.");
        return;
      }
      try {
        const result = await loadVerification(candidateToken);
        setToken(candidateToken);
        setVerification(result);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Verification is temporarily unavailable.");
      } finally {
        window.history.replaceState(null, "", window.location.pathname);
      }
    }
  }, []);

  if (error) return <PortalMessage message={error} />;
  if (!verification || !token) return <PortalMessage message="Loading your secure verification request…" />;
  return <VerificationContent token={token} verification={verification} />;
}

function VerificationContent({ token, verification }: {
  token: string; verification: CandidateVerification;
}) {
  return <main className={styles.page}>
    <header><Brand /><span><LockKeyhole size={14} /> Private verification link</span></header>
    <section className={styles.hero}>
      <div><span className={styles.kicker}>Candidate consent</span>
        <h1>A clear check.<br />Nothing hidden.</h1>
        <p>{verification.organizationName} uses Authenti8 to verify the integrity of this interview.
          Review exactly what is observed before choosing whether to continue.</p></div>
      <InterviewCard verification={verification} />
    </section>
    <section className={styles.consentGrid}>
      <div className={styles.scope}><span className={styles.kicker}>What is observed</span>
        <h2>Limited to interview integrity.</h2><ScopeItems /></div>
      <div className={styles.decision}><ShieldCheck size={30} /><h2>Your permission comes first.</h2>
        <p>Monitoring cannot begin until you accept. Access is limited to 15 minutes before the
          scheduled start through 30 minutes after the scheduled end, then closes automatically.</p>
        <ConsentForm consentVersion={verification.consentVersion} token={token} />
        <small>Consent text version {verification.consentVersion}</small></div>
    </section>
  </main>;
}

function InterviewCard({ verification }: { verification: CandidateVerification }) {
  return <aside className={styles.interviewCard}><span>Interview details</span>
    <h2>{verification.interviewTitle}</h2><p>{verification.candidateName || verification.candidateEmail}</p>
    <div><CalendarClock size={17} /><span><strong>{formatDate(verification.scheduledStart)}</strong>
      <small>{formatTime(verification.scheduledStart)} – {formatTime(verification.scheduledEnd)}</small>
    </span></div><small>Requested by {verification.organizationName}</small></aside>;
}

function ScopeItems() {
  const items = [
    [MonitorCheck, "Running applications and visible windows", "Used to identify prohibited assistance or overlays."],
    [Eye, "Hidden overlays and browser extensions", "Checks for tools that can alter or assist the interview."],
    [ShieldCheck, "Audio configuration", "Verifies the active interview audio setup—not conversation content."],
    [FileX, "No personal files or messages", "Authenti8 does not read documents, chats, passwords, or browsing history."],
  ] as const;
  return <div className={styles.scopeItems}>{items.map(([Icon, title, copy]) =>
    <article key={title}><Icon size={19} /><div><strong>{title}</strong><p>{copy}</p></div></article>)}</div>;
}

function PortalMessage({ message }: { message: string }) {
  return <main className={`${styles.page} ${styles.portalState}`}><Brand />
    <section><ShieldCheck size={34} /><h1>Candidate verification</h1><p>{message}</p></section>
  </main>;
}

async function loadVerification(token: string) {
  const response = await fetch("/api/v1/candidate/verification", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  });
  if (response.status === 404 || response.status === 410) {
    throw new Error("This verification link is invalid, expired, or already used.");
  }
  if (!response.ok) throw new Error("Candidate verification is temporarily unavailable.");
  return response.json() as Promise<CandidateVerification>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(value));
}
