import type { InterviewSummary } from "@authenti8/contracts";
import { CalendarDays, ExternalLink, UserRound } from "lucide-react";
import Link from "next/link";
import { getServerApi } from "@/lib/server-api";
import { LocalDateTime } from "@/components/dashboard/local-date-time";

export default async function MeetingsPage() {
  const meetings = await getServerApi<InterviewSummary[]>("/meetings");
  return (
    <div className="dashboard-page">
      <header className="page-header">
        <div><span>Meetings</span><h1>Interview coverage</h1><p>See which qualifying Google Calendar interviews are protected by an available credit.</p></div>
        <Link className="button-secondary" href="/dashboard/integrations">Manage integration</Link>
      </header>
      {meetings.length ? <MeetingList meetings={meetings} /> : <EmptyMeetings />}
    </div>
  );
}

function MeetingList({ meetings }: { meetings: InterviewSummary[] }) {
  return <section className="meeting-list">{meetings.map((meeting) => (
    <article className="meeting-row" id={meeting.id} key={meeting.id}>
      <MeetingDate start={meeting.scheduledStart} />
      <div className="meeting-copy"><span><LocalDateTime display="date-time" value={meeting.scheduledStart} /></span><h2>{meeting.title}</h2><p><UserRound size={13} /> {meeting.candidateEmail}</p></div>
      <ProtectionBadge status={meeting.protectionStatus ?? "PENDING"} />
      <a aria-label={`Open ${meeting.title} in Google Meet`} href={meeting.meetUrl} rel="noreferrer" target="_blank"><ExternalLink size={16} /></a>
    </article>
  ))}</section>;
}

function ProtectionBadge({ status }: { status: InterviewSummary["protectionStatus"] }) {
  const label = status === "RESERVED" || status === "CONSUMED"
    ? "Protected" : status.replaceAll("_", " ");
  return <span className={`status-badge ${status.toLowerCase()}`}>{label}</span>;
}

function MeetingDate({ start }: { start: string }) {
  return <div className="meeting-date"><strong><LocalDateTime display="day" value={start} /></strong><span><LocalDateTime display="month" value={start} /></span></div>;
}

function EmptyMeetings() {
  return <div className="empty-state"><CalendarDays size={28} /><h2>No qualifying interviews yet</h2><p>Connect Google Calendar, then schedule a Google Meet event with an interview title and an external candidate attendee.</p><Link className="button-primary" href="/dashboard/integrations">Connect an integration</Link></div>;
}
