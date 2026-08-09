import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  BillingService, dodoAmountMinor, isDefinitiveCheckoutStatus, matchesDodoProduct, parseCheckoutResponse,
  parseDodoCheckoutStatus, parseDodoCustomerId, parseDodoPayment, parseDodoSubscription,
  parsePortalResponse, subscriptionEventType,
} from "./billing.service.js";
import { dodoWebhookId, verifyDodoWebhook } from "./dodo-webhook.js";

test("Dodo webhooks require a fresh valid Standard Webhooks signature", () => {
  const raw = Buffer.from('{"type":"payment.succeeded"}');
  const id = "evt_test";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secretBytes = Buffer.from("01234567890123456789012345678901");
  const secret = `whsec_${secretBytes.toString("base64")}`;
  const signature = createHmac("sha256", secretBytes)
    .update(`${id}.${timestamp}.${raw.toString("utf8")}`).digest("base64");
  const headers = {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  };
  assert.equal(verifyDodoWebhook(raw, headers, secret), true);
  assert.equal(verifyDodoWebhook(Buffer.from("tampered"), headers, secret), false);
  assert.equal(verifyDodoWebhook(raw, headers, "not-a-webhook-secret"), false);
  assert.equal(verifyDodoWebhook(raw, headers, "whsec_"), false);
  assert.equal(verifyDodoWebhook(raw, headers, "whsec_c2hvcnQ="), false);
  assert.equal(dodoWebhookId({ "webhook-id": "canonical", id: "payload-id" }), "canonical");
});

test("Dodo webhook amounts are normalized from provider-specific fields", () => {
  assert.equal(dodoAmountMinor({ type: "payment.succeeded",
    data: { total_amount: 100000, amount: 1 } }), 100000);
  assert.equal(dodoAmountMinor({ type: "refund.succeeded", data: { amount: 500 } }), 500);
  assert.equal(dodoAmountMinor({ type: "dispute.lost",
    data: { amount: "10.50", currency: "USD" } }), 1050);
  assert.equal(dodoAmountMinor({ type: "dispute.lost",
    data: { amount: "1050", currency: "JPY" } }), 1050);
  assert.equal(dodoAmountMinor({ type: "dispute.lost",
    data: { amount: "invalid", currency: "USD" } }), null);
});

test("only definitive checkout rejections release the local checkout lock", () => {
  assert.equal(isDefinitiveCheckoutStatus(200), false);
  assert.equal(isDefinitiveCheckoutStatus(400), true);
  assert.equal(isDefinitiveCheckoutStatus(422), true);
  assert.equal(isDefinitiveCheckoutStatus(408), false);
  assert.equal(isDefinitiveCheckoutStatus(409), false);
  assert.equal(isDefinitiveCheckoutStatus(429), false);
  assert.equal(isDefinitiveCheckoutStatus(500), false);
});

test("checkout responses must include both provider identifiers", () => {
  const checkoutUrl = "https://test.checkout.dodopayments.com/session/checkout";
  assert.deepEqual(parseCheckoutResponse({ session_id: "session", checkout_url: checkoutUrl }),
    { session_id: "session", checkout_url: checkoutUrl });
  assert.throws(() => parseCheckoutResponse({ session_id: "session" }));
  assert.throws(() => parseCheckoutResponse({ session_id: "session",
    checkout_url: "http://checkout.dodopayments.com/session/checkout" }));
  assert.throws(() => parseCheckoutResponse({ session_id: "session",
    checkout_url: "https://dodopayments.example/session/checkout" }));
  assert.throws(() => parseCheckoutResponse("not-json"));
});

test("Dodo portal responses require an exact customer and secure redirect", () => {
  assert.equal(parseDodoCustomerId({ customer: { customer_id: "cus_123" } }), "cus_123");
  assert.throws(() => parseDodoCustomerId({ customer: {} }));
  assert.deepEqual(parsePortalResponse({ link: "https://test.customer.dodopayments.com/session" }),
    { link: "https://test.customer.dodopayments.com/session" });
  assert.deepEqual(parsePortalResponse({ link: "https://customer.dodopayments.com/session" }),
    { link: "https://customer.dodopayments.com/session" });
  assert.throws(() => parsePortalResponse({ link: "http://example.com/session" }));
  assert.throws(() => parsePortalResponse({ link: "https://example.com/session" }));
  assert.throws(() => parsePortalResponse({
    link: "https://customer.dodopayments.com.evil.example/session",
  }));
  assert.throws(() => parsePortalResponse({
    link: "https://customer.dodopayments.com:8443/session",
  }));
});

test("billing webhooks must carry the configured product and quantity", () => {
  const payment = { type: "payment.succeeded", data: {
    metadata: { quantity: "3" }, product_cart: [{ product_id: "extra", quantity: 3 }],
  } };
  assert.equal(matchesDodoProduct(payment, "EXTRA_CREDITS", "extra"), true);
  assert.equal(matchesDodoProduct(payment, "EXTRA_CREDITS", "professional"), false);
  assert.equal(matchesDodoProduct({ type: "subscription.active",
    data: { product_id: "professional" } }, "PROFESSIONAL", "professional"), true);
  assert.equal(matchesDodoProduct({ type: "payment.succeeded",
    data: { subscription_id: "subscription", product_cart: null } },
  "PROFESSIONAL", "professional"), true);
});

test("subscription updates follow the provider lifecycle state", () => {
  assert.equal(subscriptionEventType({ type: "subscription.updated",
    data: { status: "active" } }), "subscription.updated");
  assert.equal(subscriptionEventType({ type: "subscription.updated",
    data: { status: "on_hold" } }), "subscription.on_hold");
  assert.equal(subscriptionEventType({ type: "subscription.updated",
    data: { status: "cancelled" } }), "subscription.cancelled");
  assert.equal(subscriptionEventType({ type: "subscription.updated",
    data: { status: "pending" } }), null);
  assert.equal(subscriptionEventType({ type: "subscription.active" }), "subscription.active");
});

test("checkout reconciliation binds the exact paid session and subscription", () => {
  assert.deepEqual(parseDodoCheckoutStatus({ payment_status: "succeeded", payment_id: "pay_1" }),
    { status: "succeeded", paymentId: "pay_1" });
  assert.deepEqual(parseDodoPayment({ status: "succeeded", checkout_session_id: "checkout_1",
    subscription_id: "subscription_1",
    product_cart: [{ product_id: "professional", quantity: 1 }] },
  "checkout_1", "professional"), { subscriptionId: "subscription_1" });
  assert.throws(() => parseDodoPayment({ status: "succeeded",
    checkout_session_id: "another_checkout", subscription_id: "subscription_1",
    product_cart: [{ product_id: "professional", quantity: 1 }] },
  "checkout_1", "professional"));
  assert.deepEqual(parseDodoSubscription({ product_id: "professional", status: "active",
    previous_billing_date: "2026-08-01T00:00:00Z",
    next_billing_date: "2026-09-01T00:00:00Z",
    cancel_at_next_billing_date: true }, "professional"), {
    status: "active", periodStart: "2026-08-01T00:00:00Z",
    periodEnd: "2026-09-01T00:00:00Z", cancelAtPeriodEnd: true,
  });
});

test("subscription lifecycle events route through the stored provider binding", async () => {
  const organizationId = "7f3e4b79-b619-4ca3-9392-23c4a3ed9bf7";
  const checkoutIntentId = "87cc2062-8894-4ca5-a9e7-7cf53799562a";
  const calls: Array<{ name: string; input: object }> = [];
  const service = Object.create(BillingService.prototype) as BillingService;
  Reflect.set(service, "config", { dodo: { professionalProductId: "professional" } });
  Reflect.set(service, "supabase", { rpc: async (name: string, input: object) => {
    calls.push({ name, input });
    if (name === "authenti8_billing_subscription_context") {
      return { organizationId, checkoutIntentId, checkoutSessionId: "checkout-1" };
    }
    return { applied: true };
  } });
  await service.applyWebhook({ id: "subscription-event", type: "subscription.renewed",
    data: { subscription_id: "subscription-1", product_id: "professional",
      next_billing_date: "2026-09-01T00:00:00Z" } });
  assert.equal(calls[0]?.name, "authenti8_billing_subscription_context");
  assert.deepEqual(calls[1], { name: "authenti8_apply_billing_event", input: {
    eventId: "subscription-event", eventType: "subscription.renewed", organizationId,
    purpose: "PROFESSIONAL", quantity: 1, subscriptionId: "subscription-1", paymentId: "",
    checkoutSessionId: "checkout-1", checkoutIntentId, amountMinor: null, currency: "",
    occurredAt: calls[1] && "occurredAt" in calls[1].input
      ? (calls[1].input as Record<string, unknown>).occurredAt : "",
    periodStart: null, periodEnd: "2026-09-01T00:00:00Z", cancelAtPeriodEnd: null,
  } });
});

test("an unbound metadata-free subscription event remains retryable", async () => {
  const service = Object.create(BillingService.prototype) as BillingService;
  Reflect.set(service, "config", { dodo: { professionalProductId: "professional" } });
  Reflect.set(service, "supabase", { rpc: async () => null });
  await assert.rejects(service.applyWebhook({ id: "early-subscription", type: "subscription.active",
    data: { subscription_id: "subscription-early", product_id: "professional" } }),
  /not bound to an authorized checkout/);
});

test("unsupported subscription lifecycle events are ignored before provider routing", async () => {
  let rpcCalled = false;
  const service = Object.create(BillingService.prototype) as BillingService;
  Reflect.set(service, "config", { dodo: { professionalProductId: "professional" } });
  Reflect.set(service, "supabase", { rpc: async () => {
    rpcCalled = true;
    return null;
  } });
  assert.deepEqual(await service.applyWebhook({ id: "pending-subscription",
    type: "subscription.updated", data: { subscription_id: "subscription-pending",
      product_id: "professional", status: "pending" } }), { ignored: true });
  assert.equal(rpcCalled, false);
});
