import type { BillingGrant, OrganizationMembersOverview, WalletsOverview } from "@authenti8/contracts";
import { CreditCard, UserPlus, WalletCards } from "lucide-react";
import Link from "next/link";
import { getServerApi, requireSession } from "@/lib/server-api";
import { adjustWallet, manageBillingGrant } from "./actions";
import { BillingDelegationForm } from "./billing-delegation-form";

export default async function WalletsPage() {
  await requireSession();
  const wallets = await getServerApi<WalletsOverview>("/organization/members/wallets");
  const members = wallets.role === "OWNER"
    ? await getServerApi<OrganizationMembersOverview>("/organization/members") : null;
  const grants = wallets.role === "OWNER"
    ? await getServerApi<BillingGrant[]>("/organization/members/billing-grants") : [];
  const canAllocate = wallets.role !== "HR";
  const totals = wallets.wallets.reduce((total, wallet) => ({
    available: total.available + wallet.available, reserved: total.reserved + wallet.reserved,
    consumed: total.consumed + wallet.consumed }), { available: 0, reserved: 0, consumed: 0 });
  return <div className="dashboard-page wallets-page"><header className="page-header"><div>
    <span>Organization credits</span><h1>Interview wallets</h1><p>Allocate organization credits to
      HR interviewers and control delegated purchasing from one place.</p></div></header>
    <section className="wallet-summary" aria-label="HR wallet totals"><div><span>Available</span>
      <strong>{totals.available}</strong></div><div><span>Reserved</span><strong>{totals.reserved}</strong>
      </div><div><span>Consumed</span><strong>{totals.consumed}</strong></div></section>
    <section className="wallet-panel"><div className="wallet-title"><WalletCards /><div>
      <h2>HR credit allocation</h2><p>Every reservation and use remains linked to its interview.</p>
    </div></div><div className="wallet-grid">{wallets.wallets.length ? wallets.wallets.map((wallet) =>
      <article key={wallet.memberUserId}><div className="wallet-person"><span>
        {wallet.name.slice(0, 1).toUpperCase()}</span><div><strong>{wallet.name}</strong>
        <small>{wallet.email}</small></div></div>
        <dl><div><dt>Available</dt><dd>{wallet.available}</dd></div><div><dt>Reserved</dt>
          <dd>{wallet.reserved}</dd></div><div><dt>Consumed</dt><dd>{wallet.consumed}</dd></div></dl>
        {canAllocate && <form className="wallet-adjust" action={adjustWallet}><input type="hidden"
          name="memberUserId" value={wallet.memberUserId} /><div><label>Action<select name="operation">
          <option value="GRANT">Add credits</option><option value="REDUCE">Remove credits</option>
          </select></label><label>Credits<input name="quantity" type="number" min={1} max={100000}
          required placeholder="0" /></label></div><label>Reason<input name="reason" minLength={10}
          maxLength={500} required placeholder="Why is this allocation changing?" /></label>
          <button>Apply change</button></form>}</article>) : <div className="wallet-empty"><UserPlus />
        <h3>No HR wallets yet</h3><p>Invite an HR interviewer before allocating interview credits.</p>
        <Link href="/dashboard/team">Go to hiring team</Link></div>}</div></section>
    {wallets.role === "OWNER" && members && <BillingDelegation members={members} grants={grants} />}
  </div>;
}

function BillingDelegation({ members, grants }: { members: OrganizationMembersOverview;
  grants: BillingGrant[] }) {
  const managers = members.members.filter((member) => member.role === "MANAGER"
    && member.status === "ACTIVE");
  return <section className="wallet-panel"><div className="wallet-title"><CreditCard /><div>
    <h2>Manager purchase access</h2><p>Optionally allow a manager to purchase within defined limits.</p>
  </div></div>{managers.length ? <BillingDelegationForm managers={managers} /> : <div
    className="billing-empty"><p>Add an active Manager before delegating purchase access.</p>
    <Link href="/dashboard/team">Manage hiring team</Link></div>}<div className="grant-list">{grants.map((grant) =>
      <article key={grant.id}><span><strong>{grant.managerName}</strong>{grant.managerEmail}</span>
        <span>{grant.revokedAt ? "Revoked" : grant.expiresAt ? `Expires ${new Date(
          grant.expiresAt).toLocaleDateString()}` : "Active"}</span>{!grant.revokedAt &&
        <form action={manageBillingGrant}><input type="hidden" name="managerUserId"
          value={grant.managerUserId} /><input type="hidden" name="revoke" value="true" />
          <input minLength={10} maxLength={500} name="reason" required
            placeholder="Reason for revocation" /><button>Revoke</button></form>}</article>)}</div></section>;
}
