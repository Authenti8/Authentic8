import { redirect } from "next/navigation";
import type { BillingCapabilities, DashboardOverview, IntegrationSummary } from "@authenti8/contracts";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { RecruiterExtensionBridge } from "@/components/dashboard/recruiter-extension-bridge";
import { getServerApi, requireSession } from "@/lib/server-api";
import "./dashboard.css";
import "./commerce.css";
import "./team/team.css";
import "./wallets/wallets.css";

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const session = await requireSession();
  if (!session.organization) redirect("/onboarding");
  const [health, integration, billing] = await Promise.all([
    getServerApi<DashboardOverview>("/overview"),
    getServerApi<IntegrationSummary>("/integrations"),
    getServerApi<BillingCapabilities>("/billing/capabilities"),
  ]);
  return <DashboardShell canViewBilling={billing.canPurchase} health={health}
    integration={integration} session={session}>
    <RecruiterExtensionBridge extensionId={process.env.RECRUITER_EXTENSION_ID}
      organizationId={session.organization.id} />
    {children}
  </DashboardShell>;
}
