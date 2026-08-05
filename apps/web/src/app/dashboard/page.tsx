import { CalendarClock, CircleCheck, Link2, ShieldCheck } from "lucide-react";
import { requireSession } from "@/lib/server-api";

export default async function DashboardPage() {
  const session = await requireSession();
  return (
    <div className="dashboard-page">
      <header className="page-header"><div><span>Overview</span><h1>Welcome, {session.user.fullName.split(" ")[0]}</h1><p>Your workspace foundation is ready for pilot configuration.</p></div><div className="pilot-badge"><i /> Pilot workspace</div></header>
      <section className="dashboard-cards">
        <StatCard icon={Link2} label="Pilot interviews" value="0" note="No sessions configured" />
        <StatCard icon={CalendarClock} label="Upcoming" value="0" note="Calendar connection pending" />
        <StatCard icon={CircleCheck} label="Reports ready" value="0" note="Reports appear after pilots" />
      </section>
      <section className="getting-started"><div><span>Getting started</span><h2>Prepare your first protected interview.</h2></div><div className="setup-list"><SetupItem done label="Organization workspace created" /><SetupItem label="Review pilot scope with Authenti8" /><SetupItem label="Connect Google Meet calendar" /><SetupItem label="Schedule recruiter preflight" /></div></section>
      <section className="evidence-banner"><ShieldCheck size={24} /><div><strong>Strict evidence policy is active</strong><p>Technical verdicts require supported tool identity, active use, and valid evidence. Recruiters cannot manually change them.</p></div></section>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, note }: { icon: typeof Link2; label: string; value: string; note: string }) {
  return <article className="stat-card"><div><span>{label}</span><Icon size={20} /></div><strong>{value}</strong><small>{note}</small></article>;
}

function SetupItem({ label, done = false }: { label: string; done?: boolean }) {
  return <div className={done ? "setup-item done" : "setup-item"}><i>{done ? "✓" : ""}</i><span>{label}</span></div>;
}
