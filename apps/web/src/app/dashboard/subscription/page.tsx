import type { BillingCapabilities, BillingCatalog, BillingHistory, BillingSummary,
  PlanKey } from "@authenti8/contracts";
import { Check, Mail } from "lucide-react";
import { BillingPortalButton } from "@/components/dashboard/billing-portal-button";
import { CheckoutButton } from "@/components/dashboard/checkout-button";
import { ExtraCreditPurchase } from "@/components/dashboard/extra-credit-purchase";
import { InvoiceButton } from "@/components/dashboard/invoice-button";
import { getServerApi, requireSession } from "@/lib/server-api";

const planDetails = [
  { key: "STARTER", name: "Starter", cadence: "forever",
    description: "For a focused first hiring workflow.", allowance: "10 interviews / month",
    hasOverage: true },
  { key: "PROFESSIONAL", name: "Professional", cadence: "per month",
    description: "For hiring teams running interviews every day.", allowance: "300 interviews / month",
    hasOverage: true },
  { key: "ENTERPRISE", name: "Enterprise", cadence: "annual agreement",
    description: "Custom capacity, invoicing, and rollout support.", allowance: "Team-defined limits",
    hasOverage: false },
] as const;

export default async function SubscriptionPage() {
  const [billing, history, capabilities, catalog] = await Promise.all([
    getServerApi<BillingSummary>("/billing"), getServerApi<BillingHistory>("/billing/history"),
    requireSession().then(() => getServerApi<BillingCapabilities>("/billing/capabilities")),
    getServerApi<BillingCatalog>("/billing/catalog"),
  ]);
  const plans = pricedPlans(catalog);
  const canManage = capabilities.canPurchase;
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
      {canManage && billingActive && supportsExtraCredits ? <ExtraCreditPurchase
        amountMinor={catalog.extraInterviewAmountMinor} currency={catalog.currency} /> : null}
      {canManage && professionalRecovery ? <BillingRecovery /> : null}
      <section className="billing-capacity"><span>Current billing period</span>
        <strong>{billing.includedUsed} of {billing.allowance} included interviews used</strong>
        <small>Renews {new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(billing.periodEnd))}</small>
      </section>
      <BillingActivity canDownloadInvoices={capabilities.canManagePortal}
        canOpenPortal={capabilities.canManagePortal && billing.plan === "PROFESSIONAL"} history={history} />
    </div>
  );
}

function BillingActivity({ history, canOpenPortal, canDownloadInvoices }: {
  history: BillingHistory; canOpenPortal: boolean; canDownloadInvoices: boolean;
}) {
  return <section className="billing-history"><div className="card-heading"><span>Transactions</span>
    <h2>Payment and credit history</h2><p>Credits are added only after a verified provider webhook.</p>
    </div>{history.payments.length ? <div className="billing-history-rows">{history.payments.map((payment) =>
      <div key={payment.id}><span><strong>{payment.purpose.replaceAll("_", " ")}</strong>
        <small>{new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(payment.createdAt))}</small>
      </span><b>{payment.amountMinor === null ? "Verified" : `${payment.currency || ""} ${(payment.amountMinor / 100).toFixed(2)}`}</b>
        {canDownloadInvoices ? <InvoiceButton paymentId={payment.id} /> : null}</div>)}</div>
      : <p>No completed payments yet.</p>}
    <div className="card-heading"><span>Credit ledger</span><h2>Credit activity</h2></div>
    {history.transactions.length ? <div className="billing-history-rows">
      {history.transactions.map((transaction) => <div key={transaction.id}><span>
        <strong>{transaction.kind.replaceAll("_", " ")}</strong><small>
          {new Intl.DateTimeFormat("en", { dateStyle: "medium" })
            .format(new Date(transaction.createdAt))}</small></span>
        <b>{transaction.amount > 0 ? "+" : ""}{transaction.amount} credits</b></div>)}</div>
      : <p>No credit activity yet.</p>}
    {canOpenPortal ? <div className="invoice-action"><p>Download provider-issued invoices and receipts from the secure billing portal.</p>
      <BillingPortalButton label="Open invoices" /></div> : null}</section>;
}

function PlanCard({ plan, billing, canManage }: {
  plan: ReturnType<typeof pricedPlans>[number];
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

function pricedPlans(catalog: BillingCatalog) {
  const format = (amount: number) => new Intl.NumberFormat("en", { style: "currency",
    currency: catalog.currency, maximumFractionDigits: 2 }).format(amount / 100);
  return planDetails.map((plan) => ({ ...plan,
    price: plan.key === "STARTER" ? format(0) : plan.key === "PROFESSIONAL"
      ? format(catalog.professionalAmountMinor) : "Custom",
    overage: plan.hasOverage ? `${format(catalog.extraInterviewAmountMinor)} per extra interview`
      : null }));
}

function PlanAction({ current, manageable, plan, canManage }: {
  current: boolean;
  manageable: boolean;
  plan: PlanKey;
  canManage: boolean;
}) {
  if (!canManage) return current
    ? <button className="button-secondary" disabled>Active plan</button>
    : <span className="plan-note">An owner must approve manager purchasing access.</span>;
  if (manageable) return <BillingPortalButton label={current ? "Manage billing" : "Restore billing"} />;
  if (current) return <button className="button-secondary" disabled>Active plan</button>;
  if (plan === "PROFESSIONAL") return <CheckoutButton label="Choose Professional" purpose="PROFESSIONAL" />;
  if (plan === "ENTERPRISE") return <a className="button-secondary" href="mailto:sales@authenti8.com?subject=Authenti8 Enterprise"><Mail size={15} /> Contact sales</a>;
  return <span className="plan-note">Starter is enabled automatically for new workspaces.</span>;
}

function BillingRecovery() {
  return <section className="extra-credit-card"><div><span>Billing recovery</span><h2>Restore Professional before buying credits</h2><p>Use Restore billing above to update the payment method for your existing subscription. Access returns after Dodo confirms reactivation.</p></div></section>;
}
