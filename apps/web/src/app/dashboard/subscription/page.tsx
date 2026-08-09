import type { BillingSummary, PlanKey } from "@authenti8/contracts";
import { Check, Mail } from "lucide-react";
import { BillingPortalButton } from "@/components/dashboard/billing-portal-button";
import { CheckoutButton } from "@/components/dashboard/checkout-button";
import { ExtraCreditPurchase } from "@/components/dashboard/extra-credit-purchase";
import { getServerApi, requireSession } from "@/lib/server-api";

const plans = [
  { key: "STARTER", name: "Starter", price: "$0", cadence: "forever",
    description: "For a focused first hiring workflow.", allowance: "10 interviews / month",
    overage: "$5 per extra interview" },
  { key: "PROFESSIONAL", name: "Professional", price: "$1,000", cadence: "per month",
    description: "For hiring teams running interviews every day.", allowance: "300 interviews / month",
    overage: "$5 per extra interview" },
  { key: "ENTERPRISE", name: "Enterprise", price: "Custom", cadence: "annual agreement",
    description: "Custom capacity, invoicing, and rollout support.", allowance: "Team-defined limits",
    overage: null },
] as const;

export default async function SubscriptionPage() {
  const [billing, session] = await Promise.all([
    getServerApi<BillingSummary>("/billing"), requireSession(),
  ]);
  const canManage = ["OWNER", "ADMIN"].includes(session.organization?.role ?? "");
  const billingActive = ["ACTIVE", "TRIALING"].includes(billing.status);
  const supportsExtraCredits = ["STARTER", "PROFESSIONAL"].includes(billing.plan);
  const professionalRecovery = billing.plan === "PROFESSIONAL"
    && billing.status === "PAST_DUE";
  return (
    <div className="dashboard-page">
      <header className="page-header"><div><span>Plans & billing</span><h1>Simple pricing. Clear capacity.</h1><p>Every protected interview uses one credit when monitoring begins. No charge for cancelled or unstarted sessions.</p></div><div className="balance-pill"><small>Available credits</small><strong>{billing.balance}</strong></div></header>
      <section aria-label="Subscription plans" className="pricing-grid">
        {plans.map((plan) => <PlanCard billing={billing} canManage={canManage} key={plan.key} plan={plan} />)}
      </section>
      {canManage && billingActive && supportsExtraCredits ? <ExtraCreditPurchase /> : null}
      {canManage && professionalRecovery ? <BillingRecovery /> : null}
      {!canManage ? <BillingReadOnly /> : null}
    </div>
  );
}

function PlanCard({ plan, billing, canManage }: {
  plan: typeof plans[number];
  billing: BillingSummary;
  canManage: boolean;
}) {
  const current = billing.plan === plan.key
    && ["ACTIVE", "TRIALING"].includes(billing.status);
  const manageable = plan.key === "PROFESSIONAL" && billing.plan === "PROFESSIONAL"
    && ["ACTIVE", "TRIALING", "PAST_DUE"].includes(billing.status);
  return (
    <article className={`pricing-card ${plan.key === "PROFESSIONAL" ? "featured" : ""}`}>
      <div className="pricing-card-head"><span>{plan.name}</span>{current ? <small>Current plan</small> : null}</div>
      <div className="plan-price"><strong>{plan.price}</strong><span>{plan.cadence}</span></div>
      <p>{plan.description}</p>
      <ul><li><Check size={15} /> {plan.allowance}</li>{plan.overage ? <li><Check size={15} /> {plan.overage}</li> : null}<li><Check size={15} /> Evidence-backed reporting</li></ul>
      <PlanAction canManage={canManage} current={current} manageable={manageable} plan={plan.key} />
    </article>
  );
}

function PlanAction({ current, manageable, plan, canManage }: {
  current: boolean;
  manageable: boolean;
  plan: PlanKey;
  canManage: boolean;
}) {
  if (!canManage) return current
    ? <button className="button-secondary" disabled>Active plan</button>
    : <span className="plan-note">Only workspace owners and admins can change billing.</span>;
  if (manageable) return <BillingPortalButton label={current ? "Manage billing" : "Restore billing"} />;
  if (current) return <button className="button-secondary" disabled>Active plan</button>;
  if (plan === "PROFESSIONAL") return <CheckoutButton label="Choose Professional" purpose="PROFESSIONAL" />;
  if (plan === "ENTERPRISE") return <a className="button-secondary" href="mailto:sales@authenti8.com?subject=Authenti8 Enterprise"><Mail size={15} /> Contact sales</a>;
  return <span className="plan-note">Starter is enabled automatically for new workspaces.</span>;
}

function BillingReadOnly() {
  return <section className="extra-credit-card"><div><span>Billing access</span><h2>Workspace billing is read-only</h2><p>Ask a workspace owner or admin to purchase additional interview capacity.</p></div></section>;
}

function BillingRecovery() {
  return <section className="extra-credit-card"><div><span>Billing recovery</span><h2>Restore Professional before buying credits</h2><p>Use Restore billing above to update the payment method for your existing subscription. Access returns after Dodo confirms reactivation.</p></div></section>;
}
