import type { DashboardOverview, IntegrationSummary, SessionResponse } from "@authenti8/contracts";
import type { ReactNode } from "react";
import { Brand } from "../brand";
import { DashboardNav } from "./dashboard-nav";
import { LogoutButton } from "./logout-button";
import { WorkspaceWarning } from "./workspace-warning";

export function DashboardShell({ session, health, integration, canViewBilling, children }: {
  session: SessionResponse;
  health: DashboardOverview;
  integration: IntegrationSummary;
  canViewBilling: boolean;
  children: ReactNode;
}) {
  const warning = workspaceWarning(health, integration);
  return (
    <div className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <div className="sidebar-brand"><Brand /><span>Private beta</span></div>
        <div className="workspace-status"><i /><span><small>{health.balance} credits available</small><strong>{session.organization?.name ?? "Workspace"}</strong></span></div>
        <nav aria-label="Workspace navigation"><small>Workspace</small>
          <DashboardNav canViewBilling={canViewBilling} /></nav>
        <div className="sidebar-bottom">
          <div className="workspace-chip"><span>{initials(session.organization?.name ?? session.user.fullName)}</span><div><strong>{session.organization?.name ?? "Workspace"}</strong><small>{session.user.email}</small></div></div>
          <LogoutButton />
        </div>
      </aside>
      <main className="dashboard-main">
        {warning ? <WorkspaceWarning key={warning} message={warning}
          dismissible={health.status !== "PAST_DUE" && health.notificationCount > 0} /> : null}
        {children}
      </main>
    </div>
  );
}

function workspaceWarning(health: DashboardOverview, integration: IntegrationSummary) {
  if (health.status === "PAST_DUE") return "Your Professional subscription needs attention.";
  if (health.notificationCount > 0) {
    return `${health.notificationCount} interview verification ${health.notificationCount === 1 ? "alert needs" : "alerts need"} attention.`;
  }
  if (health.balance <= 0) return "No interview credits remain. Purchase credits before the next interview.";
  if (integration.status === "REAUTH_REQUIRED") return "Google Calendar authorization expired. Reconnect it from Integrations.";
  if (integration.status === "ACTIVE" && integration.lastErrorCode) {
    return "Google Calendar synchronization needs attention. Retry it from Integrations.";
  }
  if (integration.status === "ACTIVE" && integration.lastSyncedAt
    && Date.now() - Date.parse(integration.lastSyncedAt) > 6 * 3600_000) {
    return "Google Calendar synchronization is delayed. Run a manual sync from Integrations.";
  }
  return null;
}

function initials(value: string) {
  return value.split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase();
}
