"use client";

import { Bell, CalendarDays, CreditCard, LayoutDashboard, PlugZap, UsersRound,
  WalletCards } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const nav = [
  [LayoutDashboard, "Overview", "/dashboard"],
  [CalendarDays, "Meetings", "/dashboard/meetings"],
  [Bell, "Notifications", "/dashboard/notifications"],
  [UsersRound, "Hiring team", "/dashboard/team"],
  [WalletCards, "Interview wallets", "/dashboard/wallets"],
  [CreditCard, "Plans & billing", "/dashboard/subscription"],
  [PlugZap, "Integrations", "/dashboard/integrations"],
] as const;

export function DashboardNav({ canViewBilling, dashboardOrigin, paymentOrigin }: {
  canViewBilling: boolean;
  dashboardOrigin: string;
  paymentOrigin: string;
}) {
  const pathname = usePathname() ?? "";
  const onPaymentSurface = pathname === "/dashboard/subscription"
    || pathname.startsWith("/dashboard/subscription/");
  return nav.filter(([, , href]) => href !== "/dashboard/subscription" || canViewBilling)
    .map(([Icon, label, href]) => {
    const active = pathname === href;
    const billingRoute = href === "/dashboard/subscription";
    const crossSurface = billingRoute !== onPaymentSurface;
    const content = <><Icon aria-hidden size={18} /><span>{label}</span></>;
    const props = { "aria-current": active ? "page" as const : undefined,
      className: active ? "active" : undefined };
    if (crossSurface) {
      const featureOrigin = billingRoute ? paymentOrigin : dashboardOrigin;
      return <a {...props} href={new URL(href, featureOrigin).toString()} key={href}>{content}</a>;
    }
    return <Link {...props} href={href} key={href}>{content}</Link>;
    });
}
