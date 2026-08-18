import type { OrganizationMembersOverview } from "@authenti8/contracts";
import { Clock3, MailPlus, ShieldCheck, UserRoundCog, UsersRound } from "lucide-react";
import { getServerApi, requireSession } from "@/lib/server-api";
import { inviteMember, manageMember } from "./actions";

export default async function TeamPage() {
  const session = await requireSession();
  const overview = await getServerApi<OrganizationMembersOverview>("/organization/members");
  const canInvite = overview.role !== "HR";
  const activeMembers = overview.members.filter((member) => member.status === "ACTIVE").length;
  return <div className="dashboard-page team-page"><header className="page-header"><div>
    <span>Organization access</span><h1>Hiring team</h1><p>Invite people, assign responsibilities,
      and control access to {session.organization?.name ?? "your organization"}.</p></div>
    <div className="team-role-note"><ShieldCheck size={18} /><div><small>Your access</small>
      <strong>{overview.role}</strong></div></div></header>
    <div className="team-overview"><div><UsersRound size={18} /><span><strong>{activeMembers}</strong>
      active {activeMembers === 1 ? "member" : "members"}</span></div><div><Clock3 size={18} />
      <span><strong>{overview.invitations.length}</strong> pending</span></div><p>
      {roleDescription(overview.role)}</p></div>
    <div className="team-workspace"><section className="team-panel team-members-panel"><div
      className="team-panel-title"><UserRoundCog /><div><h2>People and access</h2>
      <p>Changes to access revoke active sessions immediately.</p></div></div>
      <div className="team-list">{overview.members.map((member) => <article key={member.userId}>
        <div className="member-avatar">{member.name.slice(0, 1).toUpperCase()}</div><div>
          <strong>{member.name}</strong><span>{member.email}</span></div><b>{member.role}</b>
        <span className={`member-status ${member.status.toLowerCase()}`}>{member.status}</span>
        {canManage(overview.role, member.role, member.userId !== session.user.id) &&
          <form action={manageMember}><input type="hidden" name="memberId" value={member.userId} />
            <select name="status" defaultValue={member.status}><option>ACTIVE</option>
              <option>SUSPENDED</option><option>REMOVED</option></select>
            <button type="submit">Update</button></form>}</article>)}</div></section>
    <aside className="team-side">{canInvite && <section className="team-panel"><div
      className="team-panel-title"><MailPlus /><div><h2>Invite member</h2><p>Secure invitations expire
        after 72 hours.</p></div></div><form className="team-invite" action={inviteMember}>
      <label>Work email<input name="email" placeholder="colleague@company.com" required
        type="email" /></label><label>Organization role<select name="role" defaultValue="HR">
        <option value="HR">HR interviewer</option>{overview.role === "OWNER" &&
          <option value="MANAGER">Manager</option>}</select></label>
      <button type="submit">Send invitation</button></form></section>}
    {canInvite && overview.invitations.length > 0 && <section className="team-panel pending-panel"><div
      className="team-panel-title"><Clock3 /><div><h2>Pending</h2><p>Awaiting acceptance.</p></div></div>
      <div className="invite-list">{overview.invitations.map((invite) => <article key={invite.id}>
        <span><strong>{invite.email}</strong><small>Expires {new Date(
          invite.expiresAt).toLocaleDateString()}</small></span><b>{invite.role}</b></article>)}</div>
    </section>}</aside></div></div>;
}

function canManage(actor: string, target: string, differentUser: boolean) {
  return differentUser && actor !== "HR" && (actor === "OWNER" || target === "HR");
}

function roleDescription(role: string) {
  if (role === "OWNER") return "You control managers, HR access, and organization ownership.";
  if (role === "MANAGER") return "You can manage HR access and conduct interviews.";
  return "You can conduct interviews assigned to your organization.";
}
