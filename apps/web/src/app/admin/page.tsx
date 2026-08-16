import type { AdminOverview, PilotReadiness } from "@authenti8/contracts";
import { CheckCircle2, Search, ShieldAlert, XCircle } from "lucide-react";
import Form from "next/form";
import Link from "next/link";
import { getServerApi, requireSession } from "@/lib/server-api";
import { AdminSections } from "./admin-sections";
import "./admin.css";

type SearchParams = Promise<{ query?: string | string[] }>;

export default async function AdminPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireSession();
  const raw = (await searchParams).query;
  const query = typeof raw === "string" ? raw.slice(0, 120) : "";
  const [overview, readiness] = await Promise.all([
    getServerApi<AdminOverview>(`/admin/overview?${new URLSearchParams({ query })}`),
    getServerApi<PilotReadiness>("/admin/pilot-readiness"),
  ]);
  return <main className="admin-page"><header><div><span>Internal operations</span>
    <h1>Authenti8 control room</h1><p>Audited support access, platform health, and pilot gates.</p>
    </div><Link href="/dashboard">Return to workspace</Link></header>
    <section className={`readiness ${readiness.ready ? "ready" : "blocked"}`}>
      <ShieldAlert size={24} /><div><span>Pilot release</span><h2>
        {readiness.ready ? "Ready for controlled pilot" : "Release gates are blocked"}</h2></div>
      <div className="gate-list">{readiness.checks.map((check) => <span key={check.key}>
        {check.passed ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
        {check.key.replaceAll("-", " ")}</span>)}</div></section>
    <Form action="/admin" className="admin-search"><Search size={18} />
      <input defaultValue={query} maxLength={120} name="query"
        placeholder="Search organization name or domain" />
      <button type="submit">Search</button></Form>
    <AdminSections overview={overview} userId={session.user.id} />
  </main>;
}
