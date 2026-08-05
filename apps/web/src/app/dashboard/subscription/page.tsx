import { ArrowRight, Check } from "lucide-react";

export default function SubscriptionPage() {
  return (
    <div className="dashboard-page narrow-page">
      <header className="page-header"><div><span>Pilot plan</span><h1>Design-partner access</h1><p>Self-service billing begins in Phase 6. Pilot scope and interview volume are approved with the Authenti8 team.</p></div></header>
      <section className="plan-card"><div><span className="plan-kicker">Current workspace</span><h2>White-glove pilot</h2><p>Run a narrow, supported workflow with direct setup and live operational support.</p></div><div className="plan-features"><span><Check size={16} /> Google Meet pilot</span><span><Check size={16} /> Windows 11 candidate device</span><span><Check size={16} /> Private live status</span><span><Check size={16} /> Evidence-backed report</span></div><a className="button-primary" href="mailto:pilot@authenti8.com">Plan pilot interviews <ArrowRight size={16} /></a></section>
    </div>
  );
}
