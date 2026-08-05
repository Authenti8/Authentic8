import { CalendarDays } from "lucide-react";
import { telemetrySchemaVersion } from "@authenti8/event-schemas";

export default function MeetingsPage() {
  return <div className="dashboard-page narrow-page"><header className="page-header"><div><span>Meetings</span><h1>Protected interviews</h1><p>Calendar-discovered interviews and results arrive in Phase 10. Pilot sessions are currently configured with the Authenti8 team.</p></div></header><div className="empty-state"><CalendarDays size={28} /><h2>No pilot interviews yet</h2><p>Your upcoming, live, completed, confirmed, and not-detected sessions will be listed here.</p><small>Telemetry contract v{telemetrySchemaVersion}</small></div></div>;
}
