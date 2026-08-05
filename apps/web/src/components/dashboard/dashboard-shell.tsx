import type { SessionResponse } from "@authenti8/contracts";
import type { ReactNode } from "react";
import { Brand } from "../brand";
import { DashboardNav } from "./dashboard-nav";
import { LogoutButton } from "./logout-button";

export function DashboardShell({ session, children }: { session: SessionResponse; children: ReactNode }) {
  return (
    <div className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <div className="sidebar-brand"><Brand /><span>Private beta</span></div>
        <div className="workspace-status"><i /><span><small>Current workspace</small><strong>{session.organization?.name ?? "Workspace"}</strong></span></div>
        <nav aria-label="Workspace navigation"><small>Workspace</small><DashboardNav /></nav>
        <div className="sidebar-bottom">
          <div className="workspace-chip"><span>{initials(session.organization?.name ?? session.user.fullName)}</span><div><strong>{session.organization?.name ?? "Workspace"}</strong><small>{session.user.email}</small></div></div>
          <LogoutButton />
        </div>
      </aside>
      <main className="dashboard-main">{children}</main>
    </div>
  );
}

function initials(value: string) {
  return value.split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase();
}
