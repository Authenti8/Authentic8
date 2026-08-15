import type { WorkspaceNotification } from "@authenti8/contracts";
import { Bell, CircleAlert } from "lucide-react";
import Link from "next/link";
import { LocalDateTime } from "@/components/dashboard/local-date-time";
import { getServerApi } from "@/lib/server-api";

export default async function NotificationsPage() {
  const notifications = await getServerApi<WorkspaceNotification[]>("/notifications");
  return <div className="dashboard-page"><header className="page-header"><div>
    <span>Notifications</span><h1>Important workspace activity</h1>
    <p>Deduplicated alerts for authorization, billing, candidate, monitoring, and report events.</p>
  </div></header>{notifications.length ? <section className="notification-list">
    {notifications.map((notice) => <Link className={notice.severity.toLowerCase()}
      href={notice.linkPath || "/dashboard"} key={notice.id}>
      {notice.severity === "CRITICAL" ? <CircleAlert size={19} /> : <Bell size={19} />}
      <div><strong>{notice.title}</strong><p>{notice.message}</p><small>
        <LocalDateTime display="date-time" value={notice.createdAt} /></small></div>
    </Link>)}</section> : <div className="empty-state"><Bell size={28} />
    <h2>No notifications</h2><p>Important workspace events will appear here.</p></div>}</div>;
}
