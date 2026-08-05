import type { SessionResponse } from "@authenti8/contracts";
import { CalendarDays, CreditCard, LayoutDashboard, Link2 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Brand } from "../brand";
import { LogoutButton } from "./logout-button";

const nav = [
  [LayoutDashboard, "Overview", "/dashboard"],
  [CalendarDays, "Meetings", "/dashboard/meetings"],
  [CreditCard, "Pilot plan", "/dashboard/subscription"],
  [Link2, "Connect Google", "/dashboard/connect-google"],
] as const;

export function DashboardShell({ session, children }: { session: SessionResponse; children: ReactNode }) {
  return (
    <div className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <Brand />
        <nav>{nav.map(([Icon, label, href]) => <Link key={href} href={href}><Icon size={18} />{label}</Link>)}</nav>
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
  return value.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}
