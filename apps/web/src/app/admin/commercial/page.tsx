import type { CommercialLead, CommercialOrganization, CommercialOverview,
  PlatformStaffMember } from "@authenti8/contracts";
import { ArrowLeft, BriefcaseBusiness, UsersRound } from "lucide-react";
import Link from "next/link";
import { getServerApi, requireSession } from "@/lib/server-api";
import { convertCommercialLead, manageSalesStaff, updateCommercialLead } from "./actions";
import "./commercial.css";

const stages = ["NEW", "CONTACTED", "QUALIFIED", "DEMO_SCHEDULED",
  "PROPOSAL_SENT", "WON", "LOST"];
type Query = Record<string, string | string[] | undefined>;

export default async function CommercialPage({ searchParams }: PageProps<"/admin/commercial">) {
  await requireSession();
  const query = await searchParams;
  const overview = await getServerApi<CommercialOverview>(
    `/commercial/overview?${commercialQuery(query)}`);
  const organizationQuery = first(query.organizationQuery).trim();
  const organizations = overview.role === "PLATFORM_FOUNDER" && organizationQuery.length >= 2
    ? await getServerApi<CommercialOrganization[]>(`/commercial/organizations?query=${
      encodeURIComponent(organizationQuery)}`) : [];
  const sales = overview.staff.filter((member) => member.role === "PLATFORM_SALES"
    && member.status === "ACTIVE");
  return <main className="commercial-page"><CommercialHeader overview={overview} />
    {overview.role === "PLATFORM_FOUNDER" && <StaffPanel />}
    <Pipeline overview={overview} query={query} sales={sales} organizations={organizations} /></main>;
}

function CommercialHeader({ overview }: { overview: CommercialOverview }) {
  return <><header><div><span>Commercial operations</span><h1>Founder & sales workspace</h1>
    <p>Private lead qualification and company follow-up.</p></div>
    <Link href="/"><ArrowLeft size={16} />Authenti8 home</Link></header>
    <section className="commercial-metrics"><article><BriefcaseBusiness /><strong>
      {overview.leads.length}</strong><span>Visible leads</span></article><article><UsersRound /><strong>
      {overview.staff.filter((item) => item.status === "ACTIVE").length}</strong>
      <span>Active team members</span></article></section></>;
}

function StaffPanel() {
  return <section className="commercial-panel"><div><span>Access control</span><h2>Sales team</h2></div>
    <form action={manageSalesStaff}><input name="email"
      placeholder="Existing Authenti8 account email" required type="email" />
      <select name="role" defaultValue="PLATFORM_SALES"><option value="PLATFORM_SALES">Sales</option>
        <option value="PLATFORM_FOUNDER">Founder</option></select>
      <select name="status" defaultValue="ACTIVE"><option>ACTIVE</option><option>SUSPENDED</option>
        <option>REMOVED</option></select>
      <input minLength={10} maxLength={500} name="reason"
        placeholder="Reason for access change" required /><button type="submit">Save access</button>
    </form></section>;
}

function Pipeline({ overview, query, sales, organizations }: { overview: CommercialOverview;
  query: Query; sales: PlatformStaffMember[]; organizations: CommercialOrganization[] }) {
  return <section className="commercial-panel"><div><span>Pipeline</span>
    <h2>Demo and waitlist leads</h2></div><PipelineFilters query={query} sales={sales} />
    {overview.role === "PLATFORM_FOUNDER" && <OrganizationSearch query={query} />}
    <div className="lead-list">{overview.leads.length === 0 ? <p>No leads yet.</p>
      : overview.leads.map((lead) => <LeadCard key={lead.id} lead={lead}
        overview={overview} sales={sales} organizations={organizations} />)}</div>
    {overview.nextCursor && <Link href={`?${commercialQuery({
      ...query, cursor: overview.nextCursor })}`}>Next page</Link>}</section>;
}

function OrganizationSearch({ query }: { query: Query }) {
  return <form method="get">{preservedFilters(query).map(([name, value]) =>
    <input key={name} type="hidden" name={name} value={value} />)}
    <input name="organizationQuery" minLength={2} maxLength={160}
      defaultValue={first(query.organizationQuery)} placeholder="Search organization to convert" />
    <button type="submit">Search organizations</button></form>;
}

function PipelineFilters({ query, sales }: { query: Query; sales: PlatformStaffMember[] }) {
  return <form method="get"><select name="leadType" defaultValue={first(query.leadType)}>
    <option value="">All lead types</option><option value="DEMO_REQUEST">Demo requests</option>
    <option value="WAITLIST">Waitlist</option></select>
    <select name="stage" defaultValue={first(query.stage)}><option value="">All stages</option>
      {stages.map((stage) => <option key={stage}>{stage}</option>)}</select>
    <select name="owner" defaultValue={first(query.owner)}><option value="">All owners</option>
      {sales.map((member) => <option key={member.userId} value={member.userId}>{member.name}</option>)}</select>
    <select name="followUpStatus" defaultValue={first(query.followUpStatus)}>
      <option value="">All follow-ups</option><option value="DUE">Due</option>
      <option value="UPCOMING">Upcoming</option><option value="COMPLETED">Completed</option></select>
    <input name="company" defaultValue={first(query.company)} placeholder="Company contains" />
    <button type="submit">Filter</button></form>;
}

function LeadCard({ lead, overview, sales, organizations }: { lead: CommercialLead;
  overview: CommercialOverview; sales: PlatformStaffMember[];
  organizations: CommercialOrganization[] }) {
  return <article><div className="lead-identity"><span>
    {lead.leadType === "DEMO_REQUEST" ? "Demo" : "Waitlist"}</span><h3>{lead.companyName}</h3>
    <p>{lead.fullName} · <a href={`mailto:${lead.email}`}>{lead.email}</a></p>
    <small>{lead.submissionCount} submission(s)</small></div>
    <form action={updateCommercialLead}><input type="hidden" name="leadId" value={lead.id} />
      <select aria-label="Pipeline stage" defaultValue={lead.stage} name="stage">
        {stages.map((stage) => <option key={stage}>{stage}</option>)}</select>
      {overview.role === "PLATFORM_FOUNDER" && <select aria-label="Sales owner"
        defaultValue={lead.assignedTo ?? ""} name="assignedTo"><option value="">Unassigned</option>
        {sales.map((member) => <option key={member.userId} value={member.userId}>
          {member.name}</option>)}</select>}
      <input maxLength={2000} name="note" placeholder="Optional internal note" />
      <input aria-label="Follow-up due time in UTC" name="followUpDueAt" type="datetime-local" />
      {lead.followUpDueAt && !lead.followUpCompletedAt && <button name="completeFollowUp"
        value="true" type="submit">Complete follow-up</button>}<button type="submit">Update</button>
    </form><LeadStatus lead={lead} overview={overview} organizations={organizations} /></article>;
}

function LeadStatus({ lead, overview, organizations }: { lead: CommercialLead;
  overview: CommercialOverview; organizations: CommercialOrganization[] }) {
  return <>{lead.followUpDueAt && <small>Follow-up {lead.followUpCompletedAt ? "completed" : `due ${
    new Date(lead.followUpDueAt).toLocaleString("en", { timeZone: "UTC" })} UTC`}</small>}
    {overview.role === "PLATFORM_FOUNDER" && lead.stage === "WON"
      && !lead.convertedOrganizationId && organizations.length > 0 && <form action={convertCommercialLead}>
        <input type="hidden" name="leadId" value={lead.id} />
        <select aria-label="Customer organization" name="organizationId" required>
          <option value="">Link customer organization</option>{organizations.map((item) =>
            <option key={item.id} value={item.id}>{item.name} · {item.domain}</option>)}</select>
        <button type="submit">Convert lead</button></form>}
    {overview.role === "PLATFORM_FOUNDER" && lead.stage === "WON"
      && !lead.convertedOrganizationId && organizations.length === 0
      && <small>Search for the customer organization above to link this lead.</small>}
    {lead.convertedOrganizationId && <small>Customer organization linked</small>}</>;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function commercialQuery(query: Query) {
  const output = new URLSearchParams();
  for (const key of ["leadType", "stage", "owner", "company", "followUpStatus", "cursor"]) {
    const value = first(query[key]); if (value) output.set(key, value);
  }
  output.set("limit", "25"); return output.toString();
}

function preservedFilters(query: Query) {
  return ["leadType", "stage", "owner", "company", "followUpStatus"].flatMap((name) => {
    const value = first(query[name]); return value ? [[name, value] as const] : [];
  });
}
