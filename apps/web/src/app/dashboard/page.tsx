import type { DashboardOverview } from "@authenti8/contracts";
import { ArrowRight, CalendarDays, Check, FileCheck2, Link2, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { LocalDateTime } from "@/components/dashboard/local-date-time";
import { getServerApi, requireSession } from "@/lib/server-api";

export default async function DashboardPage() {
  const [session, overview] = await Promise.all([
    requireSession(), getServerApi<DashboardOverview>("/overview"),
  ]);
  const firstName = session.user.fullName.split(" ")[0] || "there";
  const workspace = session.organization?.name ?? "Your workspace";
  return (
    <div className="dashboard-page">
      <OverviewHero firstName={firstName} overview={overview} workspace={workspace} />
      <section aria-label="Workspace metrics" className="dashboard-cards">
        <StatCard icon={Link2} label="Credits available" note={`${overview.used} consumed`} value={String(overview.balance)} />
        <StatCard icon={CalendarDays} label="Upcoming" note="Scheduled interviews" value={String(overview.upcoming)} />
        <StatCard icon={FileCheck2} label="Completed" note={`${overview.confirmed} confirmed findings`} value={String(overview.completed)} />
      </section>
      {overview.recentReports.length ? <RecentReports reports={overview.recentReports} /> : null}
      <section className="dashboard-grid">
        <LaunchChecklist integrationActive={overview.integrationActive} />
        <EvidencePanel />
      </section>
    </div>
  );
}

function RecentReports({ reports }: { reports: DashboardOverview["recentReports"] }) {
  return <section className="recent-reports"><div className="card-heading"><span>Latest evidence</span><h2>Recent reports</h2></div>{reports.map((report) => <Link href={`/dashboard/meetings#${report.interviewId}`} key={report.interviewId}><span><strong>{report.title}</strong><small><LocalDateTime display="date-time" value={report.generatedAt} /></small></span><b>{report.result.replaceAll("_", " ")}</b><ArrowRight size={14} /></Link>)}</section>;
}

function OverviewHero({ firstName, workspace, overview }: { firstName: string; workspace: string; overview: DashboardOverview }) {
  const readiness = overview.integrationActive ? 75 : 50;
  return (
    <header className="overview-hero">
      <div className="overview-copy"><span className="overview-kicker">Workspace overview</span><h1>Welcome, {firstName}.</h1><p><strong>{workspace}</strong> is ready for pilot configuration. Complete the launch steps to prepare your first protected interview.</p><div className="overview-actions"><Link className="button-primary" href="/dashboard/subscription">Plan your pilot <ArrowRight size={16} /></Link><Link className="button-secondary" href="/dashboard/meetings">View interviews</Link></div></div>
      <div className="readiness-card"><div className="readiness-top"><span>Launch readiness</span><strong>{overview.integrationActive ? "3" : "2"} of 4 complete</strong></div><div className="readiness-score"><strong>{readiness}%</strong><span>{overview.plan.toLowerCase()} workspace</span></div><div aria-label={`${readiness} percent complete`} className="readiness-track" role="progressbar" aria-valuemax={100} aria-valuemin={0} aria-valuenow={readiness}><i style={{ width: `${readiness}%` }} /></div><p><Check size={13} /> {overview.balance} interview credits ready</p></div>
    </header>
  );
}

function LaunchChecklist({ integrationActive }: { integrationActive: boolean }) {
  return (
    <section className="getting-started"><div className="card-heading"><span>Launch checklist</span><h2>Prepare your first protected interview.</h2><p>A focused path from workspace setup to interview day.</p></div><div className="setup-list"><SetupItem done label="Organization workspace created" /><SetupItem done href="/dashboard/subscription" label="Starter capacity activated" /><SetupItem done={integrationActive} href="/dashboard/integrations" label="Connect Google Meet calendar" /><SetupItem href="/dashboard/meetings" label="Review discovered interviews" /></div></section>
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
