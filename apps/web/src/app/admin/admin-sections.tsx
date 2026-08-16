import type { AdminOverview } from "@authenti8/contracts";
import { approveAdminChange, requestAdminChange, updateDispute } from "./actions";

export function AdminSections({ overview, userId }: { overview: AdminOverview; userId: string }) {
  return <><Organizations overview={overview} /><PendingChanges overview={overview} userId={userId} />
    <Rules overview={overview} /><Versions overview={overview} /><Disputes overview={overview} /></>;
}

function Organizations({ overview }: { overview: AdminOverview }) {
  return <section className="admin-table"><div className="admin-table-head"><span>Organization</span>
    <span>Subscription</span><span>Calendar</span><span>Disputes</span></div>
    {overview.organizations.map((organization) => <article key={organization.id}>
      <span><strong>{organization.name}</strong><small>{organization.domain}</small></span>
      <span><strong>{organization.plan ?? "No plan"}</strong>
        <small>{organization.subscriptionStatus ?? organization.status}</small></span>
      <span className={organization.calendarError ? "issue" : "healthy"}>
        {organization.calendarError ?? "Healthy"}</span><span>{organization.openDisputes}</span>
      <form className="inline-change" action={requestAdminChange}>
        <input type="hidden" name="action" value="REFUND_CREDITS" />
        <input type="hidden" name="targetId" value={organization.id} />
        <input aria-label={`Credits to refund to ${organization.name}`} min="1" max="999999"
          name="amount" type="number" placeholder="Credits" required />
        <input aria-label={`Refund reason for ${organization.name}`} minLength={10}
          maxLength={1000} name="reason" placeholder="Refund reason" required />
        <button type="submit">Request refund</button>
      </form></article>)}</section>;
}

function PendingChanges({ overview, userId }: { overview: AdminOverview; userId: string }) {
  return <section className="admin-operations"><div><span>Two-person control</span>
    <h2>Pending administrative changes</h2></div>
    {overview.pendingChanges.length === 0 ? <p>No changes await approval.</p>
      : overview.pendingChanges.map((change) => <article key={change.id}>
        <div><strong>{change.action.replaceAll("_", " ")}</strong>
          <small>{describePendingTarget(change, overview)}</small><small>{change.reason}</small></div>
        <form action={approveAdminChange}><input type="hidden" name="requestId" value={change.id} />
          <button type="submit" disabled={change.requestedBy === userId}>
            {change.requestedBy === userId ? "Second admin required" : "Approve"}</button>
        </form></article>)}</section>;
}

function describePendingTarget(change: AdminOverview["pendingChanges"][number],
  overview: AdminOverview) {
  if (change.action === "REFUND_CREDITS") {
    const organization = overview.organizations.find((item) => item.id === change.targetId);
    const amount = typeof change.payload.amount === "number" ? change.payload.amount : "Unknown";
    return `${organization?.name ?? "Unavailable organization"} · ${amount} credits · ${change.targetId}`;
  }
  const rule = overview.rules.find((item) => item.id === change.targetId);
  return rule ? `${rule.ruleKey} · ${rule.platform} · v${rule.version}`
    : `Unavailable rule · ${change.targetId}`;
}

function Rules({ overview }: { overview: AdminOverview }) {
  return <section className="admin-operations"><div><span>Detection governance</span>
    <h2>Published rules</h2></div>{overview.rules.map((rule) => <article key={rule.id}>
      <div><strong>{rule.ruleKey}</strong><small>{rule.platform} · v{rule.version} ·
        {` ${rule.confidence}`}</small></div>
      <form className="inline-change" action={requestAdminChange}>
        <input type="hidden" name="action" value="DISABLE_RULE" />
        <input type="hidden" name="targetId" value={rule.id} />
        <input minLength={10} maxLength={1000} name="reason" placeholder="Reason for disabling"
          required /><button type="submit" disabled={!rule.enabled || rule.status === "DISABLED"}>
          {rule.enabled && rule.status !== "DISABLED" ? "Request disable" : "Disabled"}</button>
      </form></article>)}</section>;
}

function Versions({ overview }: { overview: AdminOverview }) {
  return <section className="admin-operations"><div><span>Release inventory</span>
    <h2>Application versions</h2></div>{overview.applicationVersions.length === 0
      ? <p>No registered releases.</p> : overview.applicationVersions.map((version) => <article
        key={`${version.application}:${version.platform}:${version.version}:${version.release_channel}`}>
        <div><strong>{version.application} {version.version}</strong><small>{version.platform} ·
          {` ${version.release_channel} · ${version.source_commit_sha.slice(0, 12)}`}</small></div>
        <code title={version.artifact_digest}>{version.artifact_digest.slice(0, 16)}…</code>
      </article>)}</section>;
}

function Disputes({ overview }: { overview: AdminOverview }) {
  return <section className="admin-disputes"><div><span>Candidate support</span>
    <h2>Open disputes</h2></div>{overview.disputes.length === 0 ? <p>No open candidate disputes.</p>
      : overview.disputes.map((dispute) => <article key={dispute.id}>
        <div><strong>{dispute.reason}</strong><small>Interview {dispute.interviewId}</small></div>
        <form action={updateDispute}><input type="hidden" name="disputeId" value={dispute.id} />
          <textarea name="resolution" maxLength={1000}
            placeholder="Add review notes or a resolution (required to resolve)" />
          <button name="status" value="REVIEWED">Mark reviewed</button>
          <button className="resolve" name="status" value="RESOLVED">Resolve</button>
        </form></article>)}</section>;
}
