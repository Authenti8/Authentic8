import type { InterviewSummary, MeetingsPage, OrganizationMembersOverview } from "@authenti8/contracts";
import { CalendarDays, ExternalLink, FileText, UserRound } from "lucide-react";
import Form from "next/form";
import Link from "next/link";
import { LocalDateTime } from "@/components/dashboard/local-date-time";
import { MeetingsAutoRefresh } from "@/components/dashboard/meetings-auto-refresh";
import { getServerApi, requireSession } from "@/lib/server-api";
import { assignInterview } from "./actions";

type Search = Promise<Record<string, string | string[] | undefined>>;
const filters = ["Upcoming", "Live", "Completed", "Confirmed", "Not Detected",
  "Unable to Verify", "Cancelled"];

export default async function MeetingsPage({ searchParams }: { searchParams: Search }) {
  const session = await requireSession();
  const query = singleValues(await searchParams);
  const [meetings, team] = await Promise.all([
    getServerApi<MeetingsPage>(`/meetings?${apiQuery(query)}`),
    session.organization?.role !== "HR"
      ? getServerApi<OrganizationMembersOverview>("/organization/members") : Promise.resolve(null),
  ]);
  const hasActiveMeeting = meetings.items.some((meeting) =>
    ["MONITORING_ACTIVE", "MONITORING_INTERRUPTED", "MEETING_COMPLETED", "REPORT_PROCESSING"]
      .includes(meeting.status));
  return <div className="dashboard-page">
    <MeetingsAutoRefresh intervalMs={hasActiveMeeting || query.status === "LIVE" ? 5_000 : 30_000} />
    <header className="page-header"><div><span>Meetings</span><h1>Interview coverage</h1>
      <p>Search automatically protected interviews and open their immutable evidence timeline.</p>
    </div><Link className="button-secondary" href="/dashboard/integrations">Manage integration</Link>
    </header>
    <MeetingFilters query={query} />
    {meetings.items.length ? <MeetingList meetings={meetings.items} team={team} /> : <EmptyMeetings />}
    {meetings.nextCursor ? <Link className="button-secondary meetings-more"
      href={`/dashboard/meetings?${pageQuery(query, meetings.nextCursor)}`}>Load older meetings</Link>
      : null}
  </div>;
}

function MeetingFilters({ query }: { query: Record<string, string> }) {
  return <Form action="/dashboard/meetings" className="meeting-filters">
    <label>View<select defaultValue={query.status ?? ""} name="status"><option value="">All</option>
      {filters.map((filter) => <option key={filter} value={filter.toUpperCase().replaceAll(" ", "_")}>
        {filter}</option>)}</select></label>
    <label>Candidate<input defaultValue={query.candidate} maxLength={200} name="candidate"
      placeholder="Name or email" /></label>
    <label>Interviewer<input defaultValue={query.interviewer} maxLength={320} name="interviewer"
      placeholder="Interviewer email" type="email" /></label>
    <label>From<input defaultValue={query.from} name="from" type="date" /></label>
    <label>To<input defaultValue={query.to} name="to" type="date" /></label>
    <button className="button-primary" type="submit">Apply filters</button>
    <Link href="/dashboard/meetings">Clear</Link>
  </Form>;
}

function MeetingList({ meetings, team }: { meetings: InterviewSummary[];
  team: OrganizationMembersOverview | null }) {
  return <section className="meeting-list">{meetings.map((meeting) =>
    <article className="meeting-row" id={meeting.id} key={meeting.id}>
      <MeetingDate start={meeting.scheduledStart} />
      <div className="meeting-copy"><span><LocalDateTime display="date-time"
        value={meeting.scheduledStart} /></span><h2>{meeting.title}</h2>
        <p><UserRound size={13} /> {meeting.candidateName || meeting.candidateEmail}</p></div>
      <div className="meeting-statuses"><LifecycleBadge status={meeting.status} />
        <ProtectionBadge status={meeting.protectionStatus} /></div>
      {team && <form action={assignInterview}><input type="hidden" name="interviewId"
        value={meeting.id} /><select aria-label={`Responsible member for ${meeting.title}`}
        defaultValue={meeting.responsibleMemberUserId ?? ""} name="memberUserId" required>
        <option value="">Assign interviewer</option>{team.members.filter((member) =>
          member.status === "ACTIVE").map((member) => <option key={member.userId}
          value={member.userId}>{member.name} · {member.role}</option>)}</select>
        <button type="submit">Assign</button></form>}
      <Link aria-label={`Open evidence for ${meeting.title}`} href={`/dashboard/meetings/${meeting.id}`}>
        <FileText size={16} /></Link>
      <a aria-label={`Open ${meeting.title} in Google Meet`} href={meeting.meetUrl}
        rel="noreferrer" target="_blank"><ExternalLink size={16} /></a>
    </article>)}</section>;
}

function LifecycleBadge({ status }: { status: string }) {
  return <span className={`lifecycle-badge ${status.toLowerCase()}`}>
    {status.replaceAll("_", " ")}</span>;
}

function ProtectionBadge({ status }: { status: InterviewSummary["protectionStatus"] }) {
  const label = status === "RESERVED" || status === "CONSUMED"
    ? "Protected" : status.replaceAll("_", " ");
  return <span className={`status-badge ${status.toLowerCase()}`}>{label}</span>;
}

function MeetingDate({ start }: { start: string }) {
  return <div className="meeting-date"><strong><LocalDateTime display="day" value={start} /></strong>
    <span><LocalDateTime display="month" value={start} /></span></div>;
}

function EmptyMeetings() {
  return <div className="empty-state"><CalendarDays size={28} /><h2>No matching interviews</h2>
    <p>Try clearing the filters, or connect Google Calendar to discover qualifying interviews.</p>
    <Link className="button-primary" href="/dashboard/integrations">Connect an integration</Link></div>;
}

function singleValues(input: Record<string, string | string[] | undefined>) {
  return Object.fromEntries(Object.entries(input).flatMap(([key, value]) =>
    typeof value === "string" ? [[key, value]] : []));
}

function apiQuery(query: Record<string, string>) {
  const params = new URLSearchParams(query); params.set("limit", "25");
  return params.toString();
}

function pageQuery(query: Record<string, string>, cursor: string) {
  const params = new URLSearchParams(query); params.set("cursor", cursor); return params.toString();
}
