import { ArrowRight, CalendarDays, Check, FileCheck2, Link2, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { requireSession } from "@/lib/server-api";

export default async function DashboardPage() {
  const session = await requireSession();
  const firstName = session.user.fullName.split(" ")[0] || "there";
  const workspace = session.organization?.name ?? "Your workspace";
  return (
    <div className="dashboard-page">
      <OverviewHero firstName={firstName} workspace={workspace} />
      <section aria-label="Workspace metrics" className="dashboard-cards">
        <StatCard icon={Link2} label="Pilot interviews" note="No sessions configured" value="0" />
        <StatCard icon={CalendarDays} label="Upcoming" note="Calendar connection pending" value="0" />
        <StatCard icon={FileCheck2} label="Reports ready" note="Generated after interviews" value="0" />
      </section>
      <section className="dashboard-grid">
        <LaunchChecklist />
        <EvidencePanel />
      </section>
    </div>
  );
}

function OverviewHero({ firstName, workspace }: { firstName: string; workspace: string }) {
  return (
    <header className="overview-hero">
      <div className="overview-copy"><span className="overview-kicker">Workspace overview</span><h1>Welcome, {firstName}.</h1><p><strong>{workspace}</strong> is ready for pilot configuration. Complete the launch steps to prepare your first protected interview.</p><div className="overview-actions"><Link className="button-primary" href="/dashboard/subscription">Plan your pilot <ArrowRight size={16} /></Link><Link className="button-secondary" href="/dashboard/meetings">View interviews</Link></div></div>
      <div className="readiness-card"><div className="readiness-top"><span>Launch readiness</span><strong>1 of 4 complete</strong></div><div className="readiness-score"><strong>25%</strong><span>Workspace foundation</span></div><div aria-label="25 percent complete" className="readiness-track" role="progressbar" aria-valuemax={100} aria-valuemin={0} aria-valuenow={25}><i /></div><p><Check size={13} /> Organization workspace created</p></div>
    </header>
  );
}

function LaunchChecklist() {
  return (
    <section className="getting-started"><div className="card-heading"><span>Launch checklist</span><h2>Prepare your first pilot.</h2><p>A focused path from workspace setup to interview day.</p></div><div className="setup-list"><SetupItem done label="Organization workspace created" /><SetupItem href="/dashboard/subscription" label="Review pilot scope" /><SetupItem href="/dashboard/connect-google" label="Connect Google Meet calendar" /><SetupItem href="/dashboard/meetings" label="Schedule recruiter preflight" /></div></section>
  );
}

function EvidencePanel() {
  return (
    <aside className="evidence-panel"><div className="evidence-icon"><ShieldCheck size={22} /></div><span>Trust controls</span><h2>Evidence policy is active.</h2><p>Your workspace starts with strict, reviewable evidence controls configured for the pilot.</p><div className="evidence-list"><span><Check size={13} /> Private workspace</span><span><Check size={13} /> Evidence-backed outcomes</span><span><Check size={13} /> Protected verdict integrity</span></div><div className="evidence-status"><i /><span><strong>Policy status</strong><small>Active and enforced</small></span></div></aside>
  );
}

function StatCard({ icon: Icon, label, value, note }: { icon: typeof Link2; label: string; value: string; note: string }) {
  return <article className="stat-card"><div className="stat-card-top"><span>{label}</span><i><Icon aria-hidden size={17} /></i></div><strong>{value}</strong><small>{note}</small></article>;
}

function SetupItem({ label, href, done = false }: { label: string; href?: string; done?: boolean }) {
  const content = <><i>{done && <Check size={12} />}</i><span>{label}</span>{href && <ArrowRight aria-hidden size={14} />}</>;
  return href ? <Link className="setup-item" href={href}>{content}</Link> : <div className="setup-item done">{content}</div>;
}
