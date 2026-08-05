import { Brand } from "@/components/brand";
import type { ReactNode } from "react";
import "./auth.css";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="auth-layout">
      <aside className="auth-aside">
        <Brand />
        <div className="auth-aside-copy">
          <span>Evidence, not suspicion.</span>
          <h2>Protect the interview without changing how your team interviews.</h2>
          <p>Consent-based verification. Private live status. Clear coverage. Reproducible reports.</p>
        </div>
        <div className="auth-proof"><i /> Windows 11 · Google Meet design-partner pilot</div>
      </aside>
      <section className="auth-main">{children}</section>
    </main>
  );
}
