import type { OrganizationMembersOverview } from "@authenti8/contracts";
import { Clock3, MailPlus, ShieldCheck, UserRoundCog } from "lucide-react";
import { getServerApi, requireSession } from "@/lib/server-api";
import { inviteMember, manageMember } from "./actions";

export default async function TeamPage() {
  const session = await requireSession();
  const overview = await getServerApi<OrganizationMembersOverview>("/organization/members");
  const canInvite = overview.role !== "HR";
  return <div className="dashboard-content team-page"><header className="page-heading">
    <span>Organization access</span><h1>Hiring team</h1><p>Manage who can operate inside
      {` ${session.organization?.name ?? "your organization"}`}.</p></header>
    <section className="team-role-note"><ShieldCheck size={21} /><div><strong>Your role: 
      {overview.role}</strong><p>{roleDescription(overview.role)}</p></div></section>
    {canInvite && <section className="team-panel"><div className="team-panel-title"><MailPlus />
      <div><h2>Invite a team member</h2><p>Invitations expire after 72 hours and are bound to the
        invited email address.</p></div></div><form className="team-invite" action={inviteMember}>
      <input name="email" placeholder="colleague@company.com" required type="email" />
      <select name="role" defaultValue="HR"><option value="HR">HR</option>
        {overview.role === "OWNER" && <option value="MANAGER">Manager</option>}</select>
      <button type="submit">Send invitation</button></form></section>}
    <section className="team-panel"><div className="team-panel-title"><UserRoundCog /><div>
      <h2>Active team</h2><p>Access changes revoke active sessions immediately.</p></div></div>
      <div className="team-list">{overview.members.map((member) => <article key={member.userId}>
        <div className="member-avatar">{member.name.slice(0, 1).toUpperCase()}</div><div>
          <strong>{member.name}</strong><span>{member.email}</span></div><b>{member.role}</b>
        <span className={`member-status ${member.status.toLowerCase()}`}>{member.status}</span>
        {canManage(overview.role, member.role, member.userId !== session.user.id) &&
          <form action={manageMember}><input type="hidden" name="memberId" value={member.userId} />
            <select name="status" defaultValue={member.status}><option>ACTIVE</option>
              <option>SUSPENDED</option><option>REMOVED</option></select>
            <button type="submit">Update</button></form>}</article>)}</div></section>
    {canInvite && overview.invitations.length > 0 && <section className="team-panel"><div
      className="team-panel-title"><Clock3 /><div><h2>Pending invitations</h2>
      <p>Only the intended email account can accept.</p></div></div><div className="invite-list">
      {overview.invitations.map((invite) => <article key={invite.id}><span>{invite.email}</span>
        <b>{invite.role}</b><time>{new Date(invite.expiresAt).toLocaleDateString()}</time></article>)}</div>
    </section>}</div>;
}

function canManage(actor: string, target: string, differentUser: boolean) {
  return differentUser && actor !== "HR" && (actor === "OWNER" || target === "HR");
}

function roleDescription(role: string) {
  if (role === "OWNER") return "You control managers, HR access, and organization ownership.";
  if (role === "MANAGER") return "You can manage HR access and conduct interviews.";
  return "You can conduct interviews assigned to your organization.";
}
