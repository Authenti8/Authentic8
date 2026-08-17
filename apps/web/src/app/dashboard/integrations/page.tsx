import type { IconType } from "react-icons";
import Link from "next/link";
import { SiGooglemeet, SiWebex, SiZoom } from "react-icons/si";
import { TbBrandTeams } from "react-icons/tb";
import type { IntegrationSummary } from "@authenti8/contracts";
import { AlertTriangle, CheckCircle2, Clock3, Video, X } from "lucide-react";
import { IntegrationActions } from "@/components/dashboard/integration-actions";
import { LocalDateTime } from "@/components/dashboard/local-date-time";
import { getServerApi, requireSession } from "@/lib/server-api";

const upcoming = [
  { name: "Microsoft Teams", detail: "Teams meeting discovery", Icon: TbBrandTeams, tone: "teams" },
  { name: "Zoom", detail: "Zoom interview monitoring", Icon: SiZoom, tone: "zoom" },
  { name: "Webex", detail: "Webex meeting workflows", Icon: SiWebex, tone: "webex" },
] as const;

export default async function IntegrationsPage({ searchParams }: PageProps<"/dashboard/integrations">) {
  const [integration, session, query] = await Promise.all([
    getServerApi<IntegrationSummary>("/integrations"), requireSession(), searchParams,
  ]);
  const connected = integration.status === "ACTIVE";
  const canManage = ["OWNER", "MANAGER"].includes(session.organization?.role ?? "");
  const notice = integrationNotice(query.connected, query.error, query.warning);
  return (
    <div className="dashboard-page">
      <header className="page-header"><div><span>Integrations</span><h1>Bring interviews into one evidence layer.</h1><p>Connect the calendar that schedules your Google Meet interviews. Other meeting providers are on the roadmap.</p></div></header>
      {notice ? <IntegrationNotice {...notice} /> : null}
      <section className="integration-primary">
        <ProviderLogo Icon={SiGooglemeet} tone="meet" />
        <div className="integration-copy"><div><span>Available now</span><h2>Google Meet & Calendar</h2></div><p>Discover qualifying interviews, keep schedule changes synchronized, and prepare candidate monitoring automatically.</p>{connected ? <div className="connected-meta"><span><CheckCircle2 size={14} /> Connected as {integration.connectedEmail}</span><SyncStatus integration={integration} /></div> : null}</div>
        <IntegrationActions canManage={canManage} connected={connected} />
      </section>
      <section className="integration-grid">{upcoming.map((provider) => <ComingSoon key={provider.name} {...provider} />)}</section>
      <aside className="integration-security"><Video size={18} /><div><strong>Calendar access stays separate from sign-in.</strong><p>Authenti8 requests read-only calendar access, encrypts provider tokens at rest, and supports disconnect at any time.</p></div></aside>
    </div>
  );
}

function integrationNotice(connected: unknown, error: unknown, warning: unknown) {
  if (connected === "google") return { kind: "success" as const,
    message: "Google Calendar connected. Your first interview sync is now queued." };
  if (error === "cancelled") return { kind: "error" as const,
    message: "Google Calendar connection was cancelled. No access was granted." };
  if (error === "google") return { kind: "error" as const,
    message: "Google Calendar could not be connected. Please try again." };
  if (warning === "watch") return { kind: "warning" as const,
    message: "Google Calendar connected, but real-time updates are still being activated. Authenti8 will retry automatically." };
  return null;
}

function IntegrationNotice({ kind, message }: {
  kind: "success" | "error" | "warning";
  message: string;
}) {
  const Icon = kind === "success" ? CheckCircle2 : AlertTriangle;
  return <div className={`integration-notice ${kind}`} role={kind === "error" ? "alert" : "status"}>
    <Icon aria-hidden size={17} /><span>{message}</span>
    <Link aria-label="Dismiss notification" href="/dashboard/integrations"><X size={15} /></Link>
  </div>;
}

function SyncStatus({ integration }: { integration: IntegrationSummary }) {
  if (integration.lastErrorCode) {
    return <span className="integration-error"><AlertTriangle size={14} /> Calendar sync needs attention</span>;
  }
  return <span><Clock3 size={14} /> {integration.lastSyncedAt
    ? <LocalDateTime display="last-sync" value={integration.lastSyncedAt} />
    : "Initial sync pending"}</span>;
}

function ComingSoon({ name, detail, Icon, tone }: { name: string; detail: string; Icon: IconType; tone: string }) {
  return <article className="integration-card"><ProviderLogo Icon={Icon} tone={tone} /><div><span>Coming soon</span><h3>{name}</h3><p>{detail}</p></div></article>;
}

function ProviderLogo({ Icon, tone }: { Icon: IconType; tone: string }) {
  return <i className={`provider-logo ${tone}`}><Icon aria-hidden /></i>;
}
