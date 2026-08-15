import type { MeetingDetail } from "@authenti8/contracts";
import { ArrowLeft, CheckCircle2, Clock3, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { LocalDateTime } from "@/components/dashboard/local-date-time";
import { PrintReportButton } from "@/components/dashboard/print-report-button";
import { getServerApi } from "@/lib/server-api";

export default async function MeetingDetailPage({ params }: PageProps<"/dashboard/meetings/[id]">) {
  const { id } = await params;
  const detail = await getServerApi<MeetingDetail>(`/meetings/${encodeURIComponent(id)}`);
  return <div className="dashboard-page report-page">
    <Link className="back-link" href="/dashboard/meetings"><ArrowLeft size={15} /> Meetings</Link>
    <header className="page-header"><div><span>Integrity record</span><h1>{detail.interview.title}</h1>
      <p>{detail.interview.candidateName || detail.interview.candidateEmail} · <LocalDateTime
        display="date-time" value={detail.interview.scheduledStart} /></p></div>
      {detail.report ? <PrintReportButton /> : null}</header>
    {detail.report ? <FinalReport report={detail.report} />
      : <ReportPending status={detail.interview.status} />}
    <EvidenceTimeline events={detail.report?.timeline ?? detail.timeline} />
  </div>;
}

function FinalReport({ report }: { report: NonNullable<MeetingDetail["report"]> }) {
  return <section className="integrity-report"><div className="report-summary">
    <div><span>Detection</span><strong>{report.detectionResult.replaceAll("_", " ")}</strong></div>
    <div><span>Monitoring coverage</span><strong>{report.monitoringCoverage}%</strong></div>
    <div><span>Platform</span><strong>{report.device.platform || "Unavailable"}</strong></div>
    <div><span>Rule packs</span><strong>{report.rulePackVersions?.length
      ? report.rulePackVersions.join(", ") : report.rulePackVersion}</strong></div></div>
    <dl><dt>Candidate</dt><dd>{report.candidate.name || report.candidate.email}</dd>
      <dt>Candidate email</dt><dd>{report.candidate.email}</dd>
      <dt>Interviewer</dt><dd>{report.interviewer}</dd>
      <dt>Scheduled start</dt><dd><LocalDateTime display="date-time" value={report.scheduledStart} /></dd>
      <dt>Scheduled end</dt><dd><LocalDateTime display="date-time" value={report.scheduledEnd} /></dd>
      <dt>Duration</dt><dd>{formatDuration(report.durationSeconds)}</dd><dt>Consent</dt>
      <dd>{report.consent.status.replaceAll("_", " ")}</dd><dt>Report version</dt>
      <dd>{report.version}</dd><dt>Agent version</dt><dd>{report.device.agentVersion || "Unavailable"}</dd>
      <dt>OS version</dt><dd>{report.device.platformVersion || "Unavailable"}</dd>
      <dt>Interruptions</dt><dd>{report.interruptions.length}</dd>
      <dt>Confirmed incidents</dt><dd>{report.confirmedIncidents.length}</dd></dl>
    {report.confirmedIncidents.length ? <div className="report-incidents"><h2>Confirmed incidents</h2>
      {report.confirmedIncidents.map((incident) => <p key={incident.id}><strong>{incident.ruleKey}</strong>
        {` · ${incident.confidence} · pack ${incident.rulePackVersion} · `}
        <LocalDateTime display="date-time" value={incident.occurredAt} /></p>)}</div> : null}
    <p className="report-disclaimer">{report.disclaimer}</p></section>;
}

function ReportPending({ status }: { status: string }) {
  return <section className="report-pending"><Clock3 size={20} /><div><h2>Final report pending</h2>
    <p>Current meeting state: {status.replaceAll("_", " ")}.</p></div></section>;
}

function EvidenceTimeline({ events }: { events: Array<{ kind: string; message: string;
  occurredAt: string; integrityHash: string }> }) {
  return <section className="evidence-timeline"><header><span>Immutable activity</span>
    <h2>Evidence timeline</h2></header>{events.length ? events.map((event) =>
      <article key={`${event.occurredAt}:${event.integrityHash}`}>{event.kind === "CONFIRMED_DETECTION"
        ? <ShieldAlert size={17} /> : <CheckCircle2 size={17} />}<div><strong>{event.message}</strong>
        <small><LocalDateTime display="date-time" value={event.occurredAt} /> · Integrity {event.integrityHash.slice(0, 12)}</small>
      </div></article>) : <p>No recruiter-readable activity has been recorded.</p>}</section>;
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60); return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
