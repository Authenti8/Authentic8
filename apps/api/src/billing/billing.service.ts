import { BadGatewayException, BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import type { BillingSummary } from "@authenti8/contracts";
import { loadConfig } from "../config.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import type { CreateCheckoutDto } from "./billing.dto.js";
import { assertDodoCheckoutUrl, assertDodoPortalUrl } from "./dodo-urls.js";
import { resolveBillingRoute, type BillingPurpose } from "./billing-event-route.js";

type CheckoutResponse = { session_id: string; checkout_url: string };
type PortalContext = { subscriptionId?: string };
type PendingCheckoutContext = {
  organizationId?: string;
  checkoutIntentId?: string;
  sessionId?: string;
};
@Injectable()
export class BillingService {
  private readonly config = loadConfig();
  private readonly logger = new Logger(BillingService.name);

  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  async summary(userId: string) {
    await this.reconcilePendingCheckout(userId);
    return this.supabase.rpc<BillingSummary>("authenti8_billing_summary", { userId });
  }

  async createCheckout(userId: string, input: CreateCheckoutDto) {
    this.assertConfigured(input.purpose);
    if (input.purpose === "PROFESSIONAL") {
      await this.reconcilePendingCheckout(userId, true);
    }
    const quantity = input.purpose === "EXTRA_CREDITS" ? input.quantity ?? 1 : 1;
    const intent = await this.beginCheckout(userId, input.purpose, quantity);
    let result: CheckoutResponse;
    try {
      result = await this.requestCheckout(
        intent.email, intent.organizationId, input.purpose, quantity, intent.checkoutIntentId,
      );
    } catch (error) {
      if (error instanceof DodoCheckoutError && error.definitive) {
        await this.failCheckout(userId, intent.checkoutIntentId, true);
      }
      throw error;
    }
    try {
      await this.supabase.rpc("authenti8_complete_checkout_intent", {
        userId, checkoutIntentId: intent.checkoutIntentId, sessionId: result.session_id,
      });
    } catch (error) {
      this.logger.error(`Checkout session persistence will be recovered by webhook: ${
        error instanceof Error ? error.message : "unknown error"}`);
    }
    return { checkoutUrl: result.checkout_url };
  }

  async createPortal(userId: string) {
    if (!this.config.dodo.apiKey) {
      throw new BadRequestException("Dodo billing is not configured yet.");
    }
    const context = await this.supabase.rpc<PortalContext>("authenti8_billing_portal_context", {
      userId,
    });
    if (!context?.subscriptionId) {
      throw new BadRequestException("No manageable Professional subscription was found.");
    }
    const subscription = await this.requestDodo(
      `/subscriptions/${encodeURIComponent(context.subscriptionId)}`, "GET",
    );
    let customerId: string;
    try {
      customerId = parseDodoCustomerId(subscription);
    } catch {
      throw new BadGatewayException("Dodo returned an invalid subscription response.");
    }
    const endpoint = `/customers/${encodeURIComponent(customerId)}/customer-portal/session`;
    const portal = await this.requestDodo(endpoint, "POST", {
      return_url: `${this.config.appOrigin}/dashboard/subscription`,
    });
    try {
      return { portalUrl: parsePortalResponse(portal).link };
    } catch {
      throw new BadGatewayException("Dodo returned an invalid billing portal response.");
    }
  }

  async applyWebhook(event: DodoEvent) {
    if (!event.id) return { ignored: true };
    if (isReversal(event.type)) {
      return this.supabase.rpc("authenti8_apply_billing_reversal", {
        eventId: event.id, eventType: event.type,
        paymentId: event.data?.payment_id ?? "",
        reversalId: event.data?.refund_id ?? event.data?.dispute_id ?? event.id,
        amountMinor: dodoAmountMinor(event),
        occurredAt: event.timestamp ?? new Date().toISOString(),
      });
    }
    if (event.type === "dunning.recovered") {
      return this.applyDunningRecovery(event);
    }
    const subscriptionEvent = event.type.startsWith("subscription.");
    const eventType = subscriptionEventType(event);
    if (!eventType || (subscriptionEvent && !isSuccessful(eventType, "PROFESSIONAL"))) {
      return { ignored: true };
    }
    if (subscriptionEvent && !matchesDodoProduct(
      event, "PROFESSIONAL", this.expectedProduct("PROFESSIONAL"),
    )) return { ignored: true };
    const route = await resolveBillingRoute(event, (name, input) =>
      this.supabase.rpc(name, input));
    if (!route) return { ignored: true };
    const { purpose, quantity } = route;
    if (!subscriptionEvent
      && !matchesDodoProduct(event, purpose, this.expectedProduct(purpose))) {
      return { ignored: true };
    }
    if (!isSuccessful(eventType, purpose)) return { ignored: true };
    return this.supabase.rpc("authenti8_apply_billing_event", {
      eventId: event.id, eventType, organizationId: route.organizationId,
      purpose, quantity,
      subscriptionId: event.data?.subscription_id ?? "", paymentId: event.data?.payment_id ?? "",
      checkoutSessionId: event.data?.checkout_session_id ?? route.checkoutSessionId ?? "",
      checkoutIntentId: route.checkoutIntentId ?? "",
      amountMinor: dodoAmountMinor(event), currency: event.data?.currency ?? "",
      occurredAt: event.timestamp ?? new Date().toISOString(),
      periodStart: event.data?.previous_billing_date ?? null,
      periodEnd: event.data?.next_billing_date ?? null,
      cancelAtPeriodEnd: typeof event.data?.cancel_at_next_billing_date === "boolean"
        ? event.data.cancel_at_next_billing_date : null,
    });
  }

  private async applyDunningRecovery(event: DodoEvent) {
    const subscriptionId = event.data?.subscription_id;
    if (typeof subscriptionId !== "string" || !subscriptionId) return { ignored: true };
    const subscription = parseDodoSubscription(await this.requestDodo(
      `/subscriptions/${encodeURIComponent(subscriptionId)}`, "GET",
    ), this.expectedProduct("PROFESSIONAL"));
    if (subscription.status !== "active") return { ignored: true };
    const result = await this.supabase.rpc<{ ignored?: boolean; reason?: string }>(
      "authenti8_apply_dunning_recovery", {
      eventId: event.id, subscriptionId,
      paymentId: event.data?.payment_id ?? "",
      occurredAt: event.timestamp ?? new Date().toISOString(),
      periodStart: subscription.periodStart, periodEnd: subscription.periodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      },
    );
    if (result?.reason === "UNKNOWN_SUBSCRIPTION") {
      const error = new Error("Dodo subscription mapping is not available yet.");
      error.name = "UnboundDodoSubscriptionError";
      throw error;
    }
    return result;
  }

  private async reconcilePendingCheckout(userId: string, strict = false) {
    if (!this.config.dodo.apiKey || !this.config.dodo.professionalProductId) return;
    try {
      const pending = await this.supabase.rpc<PendingCheckoutContext>(
        "authenti8_pending_checkout_context", { userId },
      );
      if (!pending?.organizationId || !pending.checkoutIntentId || !pending.sessionId) return;
      await this.reconcileDodoSubscription(userId, {
        organizationId: pending.organizationId,
        checkoutIntentId: pending.checkoutIntentId,
        sessionId: pending.sessionId,
      });
    } catch (error) {
      this.logger.warn(`Pending Dodo checkout reconciliation failed: ${
        error instanceof Error ? error.message : "unknown error"}`);
      if (strict) {
        throw new BadGatewayException("The previous checkout could not be verified. Try again.");
      }
    }
  }

  private async reconcileDodoSubscription(userId: string, pending: Required<PendingCheckoutContext>) {
    const checkout = parseDodoCheckoutStatus(await this.requestDodo(
      `/checkouts/${encodeURIComponent(pending.sessionId)}`, "GET",
    ));
    if (["failed", "cancelled"].includes(checkout.status)) {
      await this.failCheckout(userId, pending.checkoutIntentId);
      return;
    }
    if (checkout.status !== "succeeded" || !checkout.paymentId) return;
    const payment = parseDodoPayment(await this.requestDodo(
      `/payments/${encodeURIComponent(checkout.paymentId)}`, "GET",
    ), pending.sessionId, this.config.dodo.professionalProductId);
    const subscription = parseDodoSubscription(await this.requestDodo(
      `/subscriptions/${encodeURIComponent(payment.subscriptionId)}`, "GET",
    ), this.config.dodo.professionalProductId);
    await this.applyWebhook(reconciliationEvent(
      pending, payment.subscriptionId, subscription, this.config.dodo.professionalProductId,
    ));
  }

  private async beginCheckout(userId: string, purpose: string, quantity: number) {
    const result = await this.supabase.rpc<CheckoutIntent>("authenti8_begin_checkout", {
      userId, purpose, quantity,
    });
    if (result?.reason === "ACTIVE_PLAN") {
      throw new BadRequestException("Professional is already active for this workspace.");
    }
    if (result?.reason === "ACTIVATION_PENDING") {
      throw new BadRequestException("Professional activation is still processing.");
    }
    if (result?.reason === "EXISTING_SUBSCRIPTION") {
      throw new BadRequestException("Manage the existing Professional subscription to reactivate it.");
    }
    if (result?.reason === "INACTIVE_SUBSCRIPTION") {
      throw new BadRequestException("Reactivate the workspace before purchasing extra interviews.");
    }
    if (result?.reason === "UNSUPPORTED_PLAN") {
      throw new BadRequestException("Extra interviews are available on Starter and Professional only.");
    }
    if (!result?.organizationId || !result.email || !result.checkoutIntentId) {
      throw new BadRequestException("An owner or admin workspace is required.");
    }
    return result as Required<Pick<CheckoutIntent,
      "organizationId" | "email" | "checkoutIntentId">>;
  }

  private async failCheckout(userId: string, checkoutIntentId: string, bestEffort = false) {
    try {
      await this.supabase.rpc("authenti8_fail_checkout_intent", { userId, checkoutIntentId });
    } catch (error) {
      if (!bestEffort) throw error;
      this.logger.warn(`Failed checkout cleanup will be retried by reconciliation: ${
        error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  private requestCheckout(
    email: string, organizationId: string, purpose: string, quantity: number,
    checkoutIntentId: string,
  ) {
    const productId = this.expectedProduct(
      purpose === "PROFESSIONAL" ? "PROFESSIONAL" : "EXTRA_CREDITS",
    );
    return fetch(`${this.config.dodo.baseUrl}/checkouts`, {
      method: "POST", headers: { authorization: `Bearer ${this.config.dodo.apiKey}`,
        "content-type": "application/json", "idempotency-key": checkoutIntentId },
      body: JSON.stringify({ product_cart: [{ product_id: productId, quantity }],
        customer: { email }, return_url: `${this.config.appOrigin}/dashboard/subscription?checkout=success`,
        metadata: { organizationId, purpose, quantity: String(quantity), checkoutIntentId } }),
      signal: AbortSignal.timeout(15_000),
    }).then(async (response) => {
      if (!response.ok) {
        throw new DodoCheckoutError(response.status, isDefinitiveCheckoutStatus(response.status));
      }
      try {
        return parseCheckoutResponse(await response.json());
      } catch {
        throw new DodoCheckoutError(response.status, isDefinitiveCheckoutStatus(response.status));
      }
    });
  }

  private async requestDodo(path: string, method: "GET" | "POST", query?: Record<string, string>) {
    const url = new URL(`${this.config.dodo.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method, headers: { authorization: `Bearer ${this.config.dodo.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new DodoCheckoutError(response.status, false);
    try {
      return await response.json() as unknown;
    } catch {
      throw new DodoCheckoutError(response.status, true);
    }
  }

  private expectedProduct(purpose: BillingPurpose) {
    return purpose === "PROFESSIONAL"
      ? this.config.dodo.professionalProductId : this.config.dodo.extraInterviewProductId;
  }

  private assertConfigured(purpose: string) {
    const product = purpose === "PROFESSIONAL"
      ? this.config.dodo.professionalProductId : this.config.dodo.extraInterviewProductId;
    if (!this.config.dodo.apiKey || !this.config.dodo.webhookKey || !product) {
      throw new BadRequestException("Dodo test checkout is not configured yet.");
    }
  }
}

class DodoCheckoutError extends BadGatewayException {
  constructor(status: number, readonly definitive: boolean) {
    super(`Dodo checkout failed (${status}).`);
  }
}

export function isDefinitiveCheckoutStatus(status: number) {
  return status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

export type DodoEvent = {
  id?: string;
  type: string;
  timestamp?: string;
  data?: Record<string, unknown> & { metadata?: Record<string, string> };
};

export function parseCheckoutResponse(value: unknown): CheckoutResponse {
  if (!value || typeof value !== "object") throw new Error("Invalid checkout response");
  const checkout = value as Record<string, unknown>;
  if (typeof checkout.session_id !== "string" || !checkout.session_id
    || typeof checkout.checkout_url !== "string" || !checkout.checkout_url) {
    throw new Error("Invalid checkout response");
  }
  assertDodoCheckoutUrl(checkout.checkout_url);
  return { session_id: checkout.session_id, checkout_url: checkout.checkout_url };
}

export function parseDodoCheckoutStatus(value: unknown) {
  const checkout = objectValue(value, "checkout response");
  const status = checkout.payment_status;
  if (status === null) return { status: "pending", paymentId: null };
  if (typeof status !== "string") throw new Error("Invalid Dodo checkout response");
  const paymentId = typeof checkout.payment_id === "string" ? checkout.payment_id : null;
  return { status, paymentId };
}

export function parseDodoPayment(value: unknown, sessionId: string, productId: string) {
  const payment = objectValue(value, "payment response");
  if (payment.status !== "succeeded" || payment.checkout_session_id !== sessionId
    || typeof payment.subscription_id !== "string" || !payment.subscription_id
    || !cartHasProduct(payment.product_cart, productId)) {
    throw new Error("Invalid Dodo payment response");
  }
  return { subscriptionId: payment.subscription_id };
}

export function parseDodoSubscription(value: unknown, productId: string) {
  const subscription = objectValue(value, "subscription response");
  if (subscription.product_id !== productId || typeof subscription.status !== "string") {
    throw new Error("Invalid Dodo subscription response");
  }
  return {
    status: subscription.status,
    periodStart: optionalDate(subscription.previous_billing_date),
    periodEnd: optionalDate(subscription.next_billing_date),
    cancelAtPeriodEnd: subscription.cancel_at_next_billing_date === true,
  };
}

export function matchesDodoProduct(
  event: DodoEvent, purpose: BillingPurpose, expectedProduct: string,
) {
  if (!expectedProduct) return false;
  if (event.type.startsWith("subscription.")) return event.data?.product_id === expectedProduct;
  const cart = event.data?.product_cart;
  if (purpose === "PROFESSIONAL" && cart == null) {
    return typeof event.data?.subscription_id === "string" && Boolean(event.data.subscription_id);
  }
  if (!Array.isArray(cart) || cart.length !== 1) return false;
  const item = cart[0] as Record<string, unknown>;
  const expectedQuantity = purpose === "EXTRA_CREDITS"
    ? Number(event.data?.metadata?.quantity ?? 1) : 1;
  return item.product_id === expectedProduct && item.quantity === expectedQuantity;
}

export function subscriptionEventType(event: DodoEvent) {
  if (!["subscription.updated", "subscription.plan_changed"].includes(event.type)) {
    return event.type;
  }
  const status = event.data?.status;
  if (status === "pending") return null;
  if (["cancelled", "expired", "failed", "on_hold", "paused"].includes(String(status))) {
    return `subscription.${String(status)}`;
  }
  return status === "active" ? event.type : null;
}

type CheckoutIntent = {
  organizationId?: string;
  email?: string;
  checkoutIntentId?: string;
  reason?: "ACTIVE_PLAN" | "ACTIVATION_PENDING" | "EXISTING_SUBSCRIPTION"
    | "INACTIVE_SUBSCRIPTION" | "UNSUPPORTED_PLAN";
};

export function parseDodoCustomerId(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Invalid Dodo subscription response");
  const customer = (value as Record<string, unknown>).customer;
  if (!customer || typeof customer !== "object") {
    throw new Error("Invalid Dodo subscription response");
  }
  const customerId = (customer as Record<string, unknown>).customer_id;
  if (typeof customerId !== "string" || !customerId) {
    throw new Error("Invalid Dodo subscription response");
  }
  return customerId;
}

export function parsePortalResponse(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Invalid Dodo portal response");
  const link = (value as Record<string, unknown>).link;
  if (typeof link !== "string" || !link) throw new Error("Invalid Dodo portal response");
  try {
    assertDodoPortalUrl(link);
  } catch {
    throw new Error("Invalid Dodo portal response");
  }
  return { link };
}

export function dodoAmountMinor(event: DodoEvent) {
  if (event.type.startsWith("payment.")) return integerAmount(event.data?.total_amount);
  if (event.type.startsWith("refund.")) return integerAmount(event.data?.amount);
  if (event.type.startsWith("dispute.")) {
    return decimalCurrencyAmount(event.data?.amount, event.data?.currency);
  }
  return null;
}

function integerAmount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function decimalCurrencyAmount(value: unknown, currency: unknown) {
  if (typeof value !== "string" || typeof currency !== "string") return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const digits = currencyDigits(currency);
  const fraction = match[2] ?? "";
  if (fraction.length > digits) return null;
  const minor = Number(`${match[1]}${fraction.padEnd(digits, "0")}`);
  return Number.isSafeInteger(minor) ? minor : null;
}

function currencyDigits(currency: string) {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency })
      .resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

function isSuccessful(type: string, purpose: string) {
  if (purpose === "PROFESSIONAL") return [
    "subscription.active", "subscription.renewed", "subscription.cancelled",
    "subscription.expired", "subscription.failed", "subscription.on_hold", "subscription.paused",
    "subscription.updated", "subscription.plan_changed",
    "payment.succeeded", "payment.completed",
  ].includes(type);
  return ["payment.succeeded", "payment.completed"].includes(type);
}

function isReversal(type: string) {
  return ["refund.succeeded", "dispute.accepted", "dispute.lost"].includes(type);
}

function reconciliationEvent(
  pending: Required<PendingCheckoutContext>, subscriptionId: string,
  subscription: ReturnType<typeof parseDodoSubscription>, productId: string,
): DodoEvent {
  const key = [subscriptionId, subscription.status, subscription.periodEnd,
    subscription.cancelAtPeriodEnd].join(":");
  return { id: `reconcile:${key}`, type: "subscription.updated",
    timestamp: new Date().toISOString(), data: {
      organizationId: pending.organizationId, subscription_id: subscriptionId,
      product_id: productId,
      status: subscription.status, previous_billing_date: subscription.periodStart,
      next_billing_date: subscription.periodEnd,
      cancel_at_next_billing_date: subscription.cancelAtPeriodEnd,
      metadata: { organizationId: pending.organizationId, purpose: "PROFESSIONAL",
        quantity: "1", checkoutIntentId: pending.checkoutIntentId },
    } };
}

function objectValue(value: unknown, label: string) {
  if (!value || typeof value !== "object") throw new Error(`Invalid Dodo ${label}`);
  return value as Record<string, unknown>;
}

function cartHasProduct(value: unknown, productId: string) {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const item = value[0];
  return Boolean(item && typeof item === "object"
    && (item as Record<string, unknown>).product_id === productId
    && (item as Record<string, unknown>).quantity === 1);
}

function optionalDate(value: unknown) {
  if (value == null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("Invalid Dodo subscription date");
  }
  return value;
}
