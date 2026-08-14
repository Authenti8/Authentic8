import { redirect } from "next/navigation";
import type { DashboardOverview, IntegrationSummary } from "@authenti8/contracts";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { RecruiterExtensionBridge } from "@/components/dashboard/recruiter-extension-bridge";
import { getServerApi, requireSession } from "@/lib/server-api";
import "./dashboard.css";
import "./commerce.css";

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const session = await requireSession();
  if (!session.organization) redirect("/onboarding");
  const [health, integration] = await Promise.all([
    getServerApi<DashboardOverview>("/overview"),
    getServerApi<IntegrationSummary>("/integrations"),
  ]);
  return <DashboardShell health={health} integration={integration} session={session}>
    <RecruiterExtensionBridge extensionId={process.env.RECRUITER_EXTENSION_ID}
      organizationId={session.organization.id} />
    {children}
  </DashboardShell>;
}
