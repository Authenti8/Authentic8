import type { BillingGrant, OrganizationMembersOverview, WalletsOverview } from "@authenti8/contracts";
import { CreditCard, WalletCards } from "lucide-react";
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
  return <div className="dashboard-content wallets-page"><header className="page-heading">
    <span>Organization credits</span><h1>Interview wallets</h1><p>Allocate purchased organization
      credits without creating a second balance.</p></header>
    <section className="wallet-panel"><div className="wallet-title"><WalletCards /><div>
      <h2>HR allocations</h2><p>Reservations and consumption remain linked to each interview.</p>
    </div></div><div className="wallet-grid">{wallets.wallets.length ? wallets.wallets.map((wallet) =>
      <article key={wallet.memberUserId}><strong>{wallet.name}</strong><span>{wallet.email}</span>
        <dl><div><dt>Available</dt><dd>{wallet.available}</dd></div><div><dt>Reserved</dt>
          <dd>{wallet.reserved}</dd></div><div><dt>Consumed</dt><dd>{wallet.consumed}</dd></div></dl>
        {canAllocate && <form action={adjustWallet}><input type="hidden" name="memberUserId"
          value={wallet.memberUserId} /><select name="operation"><option value="GRANT">Grant</option>
          <option value="REDUCE">Reduce</option></select><input name="quantity" type="number"
          min={1} max={100000} required placeholder="Credits" /><input name="reason" minLength={10}
          maxLength={500} required placeholder="Reason for allocation" /><button>Apply</button></form>}
      </article>) : <p>No HR wallets are available.</p>}</div></section>
    {wallets.role === "OWNER" && members && <BillingDelegation members={members} grants={grants} />}
  </div>;
}

function BillingDelegation({ members, grants }: { members: OrganizationMembersOverview;
  grants: BillingGrant[] }) {
  const managers = members.members.filter((member) => member.role === "MANAGER"
    && member.status === "ACTIVE");
  return <section className="wallet-panel"><div className="wallet-title"><CreditCard /><div>
    <h2>Manager billing delegation</h2><p>Only an owner can grant or revoke purchase access.</p>
  </div></div><BillingDelegationForm managers={managers} /><div className="grant-list">{grants.map((grant) =>
      <article key={grant.id}><span><strong>{grant.managerName}</strong>{grant.managerEmail}</span>
        <span>{grant.revokedAt ? "Revoked" : grant.expiresAt ? `Expires ${new Date(
          grant.expiresAt).toLocaleDateString()}` : "Active"}</span>{!grant.revokedAt &&
        <form action={manageBillingGrant}><input type="hidden" name="managerUserId"
          value={grant.managerUserId} /><input type="hidden" name="revoke" value="true" />
          <input minLength={10} maxLength={500} name="reason" required
            placeholder="Reason for revocation" /><button>Revoke</button></form>}</article>)}</div></section>;
}
