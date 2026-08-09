import type { DodoEvent } from "./billing.service.js";

export type BillingPurpose = "PROFESSIONAL" | "EXTRA_CREDITS";

type SubscriptionContext = {
  organizationId?: string;
  checkoutIntentId?: string;
  checkoutSessionId?: string;
};

type BillingRoute = Required<Pick<SubscriptionContext, "organizationId">> & {
  purpose: BillingPurpose;
  quantity: number;
  checkoutIntentId?: string;
  checkoutSessionId?: string;
};

export async function resolveBillingRoute(
  event: DodoEvent,
  rpc: (name: string, input: Record<string, unknown>) => Promise<SubscriptionContext | null>,
): Promise<BillingRoute | null> {
  if (!event.type.startsWith("subscription.")) return metadataRoute(event);
  const subscriptionId = event.data?.subscription_id;
  if (typeof subscriptionId !== "string" || !subscriptionId) return null;
  const context = await rpc("authenti8_billing_subscription_context", { subscriptionId });
  if (context && isUuid(context.organizationId)) {
    return { organizationId: context.organizationId, purpose: "PROFESSIONAL", quantity: 1,
      checkoutIntentId: validUuid(context.checkoutIntentId),
      checkoutSessionId: validString(context.checkoutSessionId) };
  }
  const fallback = metadataRoute(event);
  if (fallback?.purpose === "PROFESSIONAL" && fallback.checkoutIntentId) return fallback;
  throw new UnboundDodoSubscriptionError();
}

function metadataRoute(event: DodoEvent): BillingRoute | null {
  const metadata = event.data?.metadata ?? {};
  const purpose = billingPurpose(metadata.purpose);
  const quantity = billingQuantity(metadata.quantity, purpose);
  if (!purpose || !quantity || !isUuid(metadata.organizationId)) return null;
  const checkoutIntentId = validUuid(metadata.checkoutIntentId);
  if ((purpose === "EXTRA_CREDITS" || event.type.startsWith("subscription."))
    && !checkoutIntentId) return null;
  return { organizationId: metadata.organizationId, purpose, quantity, checkoutIntentId };
}

function billingPurpose(value: unknown): BillingPurpose | null {
  return value === "PROFESSIONAL" || value === "EXTRA_CREDITS" ? value : null;
}

function billingQuantity(value: unknown, purpose: BillingPurpose | null) {
  const quantity = Number(value ?? 1);
  if (!purpose || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) return null;
  return purpose === "PROFESSIONAL" && quantity !== 1 ? null : quantity;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validUuid(value: unknown) {
  return isUuid(value) ? value : undefined;
}

function validString(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

class UnboundDodoSubscriptionError extends Error {
  constructor() {
    super("Dodo subscription is not bound to an authorized checkout yet.");
    this.name = "UnboundDodoSubscriptionError";
  }
}
