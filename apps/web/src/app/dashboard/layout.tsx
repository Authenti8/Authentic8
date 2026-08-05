import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { requireSession } from "@/lib/server-api";
import "./dashboard.css";

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const session = await requireSession();
  if (!session.organization) redirect("/onboarding");
  return <DashboardShell session={session}>{children}</DashboardShell>;
}
