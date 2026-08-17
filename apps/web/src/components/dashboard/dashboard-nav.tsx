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

export function DashboardNav({ canViewBilling }: { canViewBilling: boolean }) {
  const pathname = usePathname();
  return nav.filter(([, , href]) => href !== "/dashboard/subscription" || canViewBilling)
    .map(([Icon, label, href]) => {
    const active = pathname === href;
    return <Link aria-current={active ? "page" : undefined} className={active ? "active" : undefined} href={href} key={href}><Icon aria-hidden size={18} /><span>{label}</span></Link>;
    });
}
