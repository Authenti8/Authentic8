import { CalendarPlus } from "lucide-react";

export default function ConnectGooglePage() {
  return <div className="dashboard-page narrow-page"><header className="page-header"><div><span>Google Meet</span><h1>Calendar connection</h1><p>Google login is intentionally separate from Google Calendar authorization. Calendar permission and synchronization are implemented in Phases 9–11.</p></div></header><div className="empty-state"><CalendarPlus size={28} /><h2>Calendar access is not connected</h2><p>Your account currently grants identity access only. Authenti8 will request Calendar permission explicitly when this feature is enabled.</p><button className="button-primary" disabled>Coming in the next phase</button></div></div>;
}
