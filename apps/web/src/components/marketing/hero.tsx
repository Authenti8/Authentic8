import { ArrowRight, CheckCircle2, Radio } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

export function Hero() {
  return (
    <section className="hero">
      <Image className="hero-image" src="/hero-office.png" alt="" fill priority sizes="100vw" />
      <div className="hero-wash" />
      <div className="container hero-content">
        <div className="hero-copy">
          <div className="pilot-pill"><Radio size={14} /> Design-partner pilot · Google Meet</div>
          <h1>Interview integrity.<br /><span>Backed by evidence.</span></h1>
          <p>
            Identify active use of supported real-time AI interview tools—with
            candidate consent, private live status, and an auditable report.
          </p>
          <div className="hero-actions">
            <Link className="button-primary" href="/signup">Protect a pilot interview <ArrowRight size={17} /></Link>
            <a className="button-secondary" href="#how">See how it works</a>
          </div>
          <div className="hero-notes">
            <span><CheckCircle2 size={16} /> No behavioral scoring</span>
            <span><CheckCircle2 size={16} /> Google Meet stays unchanged</span>
          </div>
        </div>
        <LiveStatusCard />
      </div>
    </section>
  );
}

function LiveStatusCard() {
  return (
    <aside className="live-card" aria-label="Example live interview status">
      <div className="live-card-top"><span>Live integrity status</span><b><i /> Active</b></div>
      <div className="candidate-row">
        <div className="candidate-avatar">JD</div>
        <div><strong>Candidate verified</strong><span>Windows 11 · coverage 100%</span></div>
      </div>
      <div className="timeline-row"><span>09:00</span><p>Consent recorded</p></div>
      <div className="timeline-row"><span>09:01</span><p>Device monitoring active</p></div>
      <div className="timeline-row current"><span>09:22</span><p>No supported tool detected</p></div>
      <small>Detection and monitoring health are reported separately.</small>
    </aside>
  );
}
