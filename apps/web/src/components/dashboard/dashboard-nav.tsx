"use client";

import { CalendarDays, CreditCard, LayoutDashboard, PlugZap } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const nav = [
  [LayoutDashboard, "Overview", "/dashboard"],
  [CalendarDays, "Meetings", "/dashboard/meetings"],
  [CreditCard, "Plans & billing", "/dashboard/subscription"],
  [PlugZap, "Integrations", "/dashboard/integrations"],
] as const;

export function DashboardNav() {
  const pathname = usePathname();
  return nav.map(([Icon, label, href]) => {
    const active = pathname === href;
    return <Link aria-current={active ? "page" : undefined} className={active ? "active" : undefined} href={href} key={href}><Icon aria-hidden size={18} /><span>{label}</span></Link>;
  });
}
