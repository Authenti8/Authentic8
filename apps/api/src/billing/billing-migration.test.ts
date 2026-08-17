import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import {
  assertEnterpriseCannotBuyExtras,
  assertNewCheckoutSupersedesRecovery,
  assertPendingPaymentBindsSubscription, advanceToDeviceConnecting,
  createProfessionalCheckout,
} from "./billing-provider-routing.helper.test.js";
test("billing allowances and Dodo events are ledger-backed and idempotent", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    await database.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY)");
    await database.exec(loadMigrations());
    const user = await rpc<{ id: string }>(database, "authenti8_create_user", {
      email: "billing@example.com", fullName: "Billing Owner",
    });
    await database.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [user.id]);
    const created = await rpc<{ organization: { id: string } }>(
      database, "authenti8_create_organization", organizationInput(user.id),
    );
    const starter = await rpc<{ plan: string; balance: number }>(
      database, "authenti8_billing_summary", { userId: user.id },
    );
    assert.deepEqual({ plan: starter.plan, balance: starter.balance }, {
      plan: "STARTER", balance: 10,
    });
    await assertEnterpriseCannotBuyExtras(database, user.id, created.organization.id);
    await assertCheckoutGate(database, user.id);
    await assertEarlyReversalRetry(database, created.organization.id, user.id);
    await assertReservationLimit(database, user.id, created.organization.id);
    await assertExtraCreditRefunds(database, created.organization.id, user.id);
    await assertPendingPaymentBindsSubscription(database, user.id, created.organization.id);
    await assertProfessionalLifecycle(database, user.id, created.organization.id);
  } finally {
    await database.close();
  }
});
test("Starter migration upgrades existing pilot workspaces idempotently", async () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    await database.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY)");
    await database.exec(loadMigrations("011_google_calendar_sync.sql"));
    const user = await rpc<{ id: string }>(database, "authenti8_create_user", {
      email: "pilot@example.com", fullName: "Pilot Owner",
    });
    await database.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [user.id]);
    const created = await rpc<{ organization: { id: string } }>(
      database, "authenti8_create_organization", organizationInput(user.id),
    );
    await database.query(
      "UPDATE subscriptions SET plan_key = 'PILOT', status = 'TRIALING' WHERE organization_id = $1",
      [created.organization.id],
    );
    await database.query("DELETE FROM credit_transactions WHERE organization_id = $1",
      [created.organization.id]);
    const migration = resolve(process.cwd(),
      "../../infrastructure/postgres/012_starter_onboarding_upgrade.sql");
    await database.exec(readFileSync(migration, "utf8"));
    const summary = await rpc<{ plan: string; status: string; balance: number }>(
      database, "authenti8_billing_summary", { userId: user.id },
    );
    assert.deepEqual({ plan: summary.plan, status: summary.status, balance: summary.balance },
      { plan: "STARTER", status: "ACTIVE", balance: 10 });
  } finally {
    await database.close();
  }
});
async function assertExtraCreditRefunds(
  database: PGlite, organizationId: string, userId: string,
) {
  const checkoutIntentId = await createExtraCheckout(database, userId, 3, "extra-session-3");
  const forged = { eventId: "event-extra-forged", eventType: "payment.succeeded",
    organizationId, purpose: "EXTRA_CREDITS", quantity: 2,
    checkoutIntentId, paymentId: "payment-forged", amountMinor: 1000, currency: "USD",
    occurredAt: new Date().toISOString() };
  assert.deepEqual(await rpc(database, "authenti8_apply_billing_event", forged),
    { ignored: true, reason: "UNAUTHORIZED_CHECKOUT" });
  const event = { eventId: "event-extra", eventType: "payment.succeeded",
    organizationId, purpose: "EXTRA_CREDITS", quantity: 3,
    checkoutIntentId, paymentId: "payment-1", amountMinor: 1500, currency: "USD",
    occurredAt: new Date().toISOString() };
  await rpc(database, "authenti8_apply_billing_event", event);
  await rpc(database, "authenti8_apply_billing_event", event);
  assert.equal((await billingBalance(database, userId)), 13);
  await database.query(
    "UPDATE credit_transactions SET created_at = now() - interval '2 months' WHERE kind = 'EXTRA_PURCHASE'",
  );
  assert.equal((await billingBalance(database, userId)), 13);
  const partial = { eventId: "refund-event-1", eventType: "refund.succeeded",
    paymentId: "payment-1", reversalId: "refund-1", amountMinor: 500,
    occurredAt: new Date().toISOString() };
  await rpc(database, "authenti8_apply_billing_reversal", partial);
  await rpc(database, "authenti8_apply_billing_reversal", partial);
  assert.equal((await billingBalance(database, userId)), 12);
  await rpc(database, "authenti8_apply_billing_reversal", {
    eventId: "refund-event-2", eventType: "refund.succeeded", paymentId: "payment-1",
    reversalId: "refund-2", amountMinor: 1000, occurredAt: new Date().toISOString(),
  });
  assert.equal((await billingBalance(database, userId)), 10);
}

async function assertCheckoutGate(database: PGlite, userId: string) {
  const input = { userId, purpose: "PROFESSIONAL", quantity: 1 };
  const first = await rpc<{ checkoutIntentId: string }>(database, "authenti8_begin_checkout", input);
  assert.ok(first.checkoutIntentId);
  const reused = await rpc<{
    checkoutIntentId: string;
    reused: boolean;
    organizationId: string;
    email: string;
  }>(
    database, "authenti8_begin_checkout", input,
  );
  assert.equal(reused.checkoutIntentId, first.checkoutIntentId);
  assert.equal(reused.reused, true);
  assert.ok(reused.organizationId);
  assert.ok(reused.email);
  await database.query(
    "UPDATE billing_checkout_sessions SET created_at = now() - interval '31 minutes' WHERE id = $1",
    [first.checkoutIntentId],
  );
  const retry = await rpc<{ checkoutIntentId: string }>(database, "authenti8_begin_checkout", input);
  assert.equal(retry.checkoutIntentId, first.checkoutIntentId);
  await rpc(database, "authenti8_fail_checkout_intent", {
    userId, checkoutIntentId: retry.checkoutIntentId,
  });
}
async function billingBalance(database: PGlite, userId: string) {
  return (await rpc<{ balance: number }>(
    database, "authenti8_billing_summary", { userId },
  )).balance;
}

async function assertEarlyReversalRetry(
  database: PGlite, organizationId: string, userId: string,
) {
  const reversal = { eventId: "early-refund-event", eventType: "refund.succeeded",
    paymentId: "early-payment", reversalId: "early-refund", amountMinor: 500,
    occurredAt: new Date().toISOString() };
  await assert.rejects(rpc(database, "authenti8_apply_billing_reversal", reversal));
  const checkoutIntentId = await createExtraCheckout(database, userId, 1, "early-extra-session");
  await rpc(database, "authenti8_apply_billing_event", { eventId: "early-payment-event",
    eventType: "payment.succeeded", organizationId, purpose: "EXTRA_CREDITS", quantity: 1,
    checkoutIntentId, paymentId: "early-payment", amountMinor: 500, currency: "USD",
    occurredAt: new Date().toISOString() });
  await rpc(database, "authenti8_apply_billing_reversal", reversal);
  const summary = await rpc<{ balance: number }>(
    database, "authenti8_billing_summary", { userId },
  );
  assert.equal(summary.balance, 10);
}
async function assertReservationLimit(database: PGlite, userId: string, organizationId: string) {
  let firstInterview = "";
  for (let index = 0; index < 11; index += 1) {
    const interview = await createInterview(database, organizationId, index);
    if (index === 0) firstInterview = interview;
    const result = await rpc<{ reserved: boolean; reason?: string }>(
      database, "authenti8_reserve_credit", { userId, interviewId: interview },
    );
    assert.equal(result.reserved, index < 10);
    if (index === 10) assert.equal(result.reason, "NO_CREDITS");
  }
  const repeat = await rpc<{ reserved: boolean }>(database, "authenti8_reserve_credit",
    { userId, interviewId: firstInterview });
  assert.equal(repeat.reserved, true);
  await rpc(database, "authenti8_release_credit", { userId, interviewId: firstInterview });
  assert.deepEqual(await rpc(database, "authenti8_reserve_credit",
    { userId, interviewId: firstInterview }), { reserved: false, reason: "MANUALLY_RELEASED" });
  const consumed = await rpc<{ consumed: boolean; reason: string }>(
    database, "authenti8_consume_credit", { userId, interviewId: firstInterview },
  );
  assert.deepEqual(consumed, { consumed: false, reason: "RELEASED" });
  await database.query("DELETE FROM credit_reservations");
  await database.query("UPDATE interviews SET status = 'EXCLUDED'");
  const monitoredInterview = await createInterview(database, organizationId, 12);
  await rpc(database, "authenti8_reserve_credit", { interviewId: monitoredInterview });
  await advanceToDeviceConnecting(database, monitoredInterview);
  assert.deepEqual(await rpc(database, "authenti8_consume_credit",
    { interviewId: monitoredInterview }), { consumed: true });
  const monitored = await database.query<{ monitoring_started_at: string; status: string }>(
    "SELECT monitoring_started_at, status FROM interviews WHERE id = $1", [monitoredInterview],
  );
  assert.ok(monitored.rows[0]?.monitoring_started_at);
  assert.equal(monitored.rows[0]?.status, "MONITORING_ACTIVE");
  await assertExpiredInterviewCannotConsume(database, organizationId);
  await database.query("DELETE FROM credit_transactions WHERE idempotency_key = $1",
    [`consume:${monitoredInterview}`]);
  await database.query("DELETE FROM credit_reservations WHERE interview_id = $1",
    [monitoredInterview]);
  const cancelledInterview = await createInterview(database, organizationId, 13);
  await database.query("UPDATE interviews SET status = 'CANCELLED' WHERE id = $1",
    [cancelledInterview]);
  assert.deepEqual(await rpc(database, "authenti8_reserve_credit", {
    interviewId: cancelledInterview,
  }), { reserved: false, reason: "INTERVIEW_NOT_ELIGIBLE" });
  assert.equal(await billingBalance(database, userId), 10);
}
async function assertExpiredInterviewCannotConsume(database: PGlite, organizationId: string) {
  const interviewId = await createInterview(database, organizationId, 14);
  await database.query(`UPDATE interviews SET scheduled_start = now() - interval '2 hours',
    scheduled_end = now() - interval '1 hour' WHERE id = $1`, [interviewId]);
  await database.query(`UPDATE credit_reservations SET status = 'RESERVED', released_at = NULL,
    release_reason = NULL WHERE interview_id = $1`, [interviewId]);
  await advanceToDeviceConnecting(database, interviewId);
  assert.deepEqual(await rpc(database, "authenti8_consume_credit", { interviewId }),
    { consumed: false, reason: "INTERVIEW_OUTSIDE_WINDOW" });
  const reservation = await database.query<{ status: string }>(
    "SELECT status FROM credit_reservations WHERE interview_id = $1", [interviewId]);
  assert.equal(reservation.rows[0]?.status, "RELEASED");
}

async function assertProfessionalLifecycle(database: PGlite, userId: string, organizationId: string) {
  const base = Date.now();
  const dates = { periodStart: new Date(base).toISOString(),
    periodEnd: new Date(Date.now() + 30 * 86400_000).toISOString() };
  const checkoutIntentId = await assertProfessionalCheckoutCompletion(
    database, userId, organizationId, base);
  await rpc(database, "authenti8_apply_billing_event", { eventId: "professional-active",
    eventType: "subscription.active", organizationId, purpose: "PROFESSIONAL",
    quantity: 1, subscriptionId: "subscription-1", checkoutIntentId,
    occurredAt: new Date(base + 1000).toISOString(), ...dates });
  const professional = await applyScheduledCancellation(
    database, userId, organizationId, base, dates,
  );
  assert.deepEqual({ plan: professional.plan, balance: professional.balance,
    cancelAtPeriodEnd: professional.cancelAtPeriodEnd },
  { plan: "PROFESSIONAL", balance: 300, cancelAtPeriodEnd: true });
  const pendingInterview = await createInterview(database, organizationId, 101);
  await rpc(database, "authenti8_reserve_credit", { interviewId: pendingInterview });
  await rpc(database, "authenti8_apply_billing_event", { eventId: "professional-paused",
    eventType: "subscription.paused", organizationId, purpose: "PROFESSIONAL",
    quantity: 1, subscriptionId: "subscription-1",
    occurredAt: new Date(base + 3000).toISOString() });
  await rpc(database, "authenti8_apply_billing_event", { eventId: "professional-stale-active",
    eventType: "subscription.active", organizationId, purpose: "PROFESSIONAL",
    quantity: 1, subscriptionId: "subscription-1",
    occurredAt: new Date(base + 2000).toISOString(), ...dates });
  await assertInactiveWorkspace(database, userId, organizationId);
  assert.deepEqual(await rpc(database, "authenti8_consume_credit", {
    interviewId: pendingInterview,
  }), { consumed: false, reason: "RELEASED" });
  await rpc(database, "authenti8_release_credit", { interviewId: pendingInterview });
  await rpc(database, "authenti8_apply_billing_event", { eventId: "professional-reactivated",
    eventType: "subscription.active", organizationId, purpose: "PROFESSIONAL",
    quantity: 1, subscriptionId: "subscription-1",
    occurredAt: new Date(base + 4000).toISOString(), ...dates });
  await rpc(database, "authenti8_apply_billing_event", { eventId: "professional-cancelled",
    eventType: "subscription.cancelled", organizationId, purpose: "PROFESSIONAL",
    quantity: 1, subscriptionId: "subscription-1",
    occurredAt: new Date(base + 6000).toISOString() });
  await rpc(database, "authenti8_apply_billing_event", { eventId: "professional-stale-renewal",
    eventType: "subscription.renewed", organizationId, purpose: "PROFESSIONAL",
    quantity: 1, subscriptionId: "subscription-1",
    occurredAt: new Date(base + 5000).toISOString(), ...dates });
  await assertDunningRecovery(database, userId, organizationId, base, dates);
  await assertProfessionalRefund(database, userId, organizationId, base, dates);
}
async function assertDunningRecovery(
  database: PGlite, userId: string, organizationId: string, base: number,
  dates: { periodStart: string; periodEnd: string },
) {
  const starter = await rpc<{ plan: string; balance: number }>(
    database, "authenti8_billing_summary", { userId },
  );
  assert.deepEqual({ plan: starter.plan, balance: starter.balance },
    { plan: "STARTER", balance: 8 });
  await rpc(database, "authenti8_apply_dunning_recovery", {
    eventId: "professional-dunning-recovered", subscriptionId: "subscription-1",
    paymentId: "professional-recovery-payment",
    occurredAt: new Date(base + 6250).toISOString(), ...dates,
  });
  const recovered = await rpc<{ plan: string; status: string; balance: number }>(
    database, "authenti8_billing_summary", { userId },
  );
  assert.deepEqual({ plan: recovered.plan, status: recovered.status, balance: recovered.balance },
    { plan: "PROFESSIONAL", status: "ACTIVE", balance: 298 });
  await rpc(database, "authenti8_apply_billing_event", { eventId: "recovered-cancelled",
    eventType: "subscription.cancelled", organizationId, purpose: "PROFESSIONAL",
    quantity: 1, subscriptionId: "subscription-1",
    occurredAt: new Date(base + 6500).toISOString() });
  await assertNewCheckoutSupersedesRecovery(database, userId, organizationId, base, dates);
}

async function applyScheduledCancellation(
  database: PGlite, userId: string, organizationId: string, base: number,
  dates: { periodStart: string; periodEnd: string },
) {
  await rpc(database, "authenti8_apply_billing_event", { eventId: "professional-updated",
    eventType: "subscription.updated", organizationId, purpose: "PROFESSIONAL",
    quantity: 1, subscriptionId: "subscription-1", cancelAtPeriodEnd: true,
    occurredAt: new Date(base + 1500).toISOString(), ...dates });
  return rpc<{ plan: string; balance: number; cancelAtPeriodEnd: boolean }>(
    database, "authenti8_billing_summary", { userId },
  );
}

async function assertProfessionalRefund(
  database: PGlite, userId: string, organizationId: string, base: number,
  dates: { periodStart: string; periodEnd: string },
) {
  await establishCurrentSubscription(database, userId, organizationId, base, dates);
  await rpc(database, "authenti8_apply_billing_event", { eventId: "professional-payment-3",
    eventType: "payment.succeeded", organizationId, purpose: "PROFESSIONAL", quantity: 1,
    subscriptionId: "subscription-3", paymentId: "professional-payment-3",
    amountMinor: 100000, currency: "USD", occurredAt: new Date(base + 12000).toISOString() });
  await rpc(database, "authenti8_apply_billing_reversal", { eventId: "professional-refund-partial",
    eventType: "refund.succeeded", paymentId: "professional-payment-3",
    reversalId: "professional-refund-partial", amountMinor: 100,
    occurredAt: new Date(base + 13000).toISOString() });
  assert.equal((await rpc<{ status: string }>(database,
    "authenti8_billing_summary", { userId })).status, "ACTIVE");
  await rpc(database, "authenti8_apply_billing_reversal", {
    eventId: "professional-refund-final", eventType: "refund.succeeded",
    paymentId: "professional-payment-3", reversalId: "professional-refund-final",
    amountMinor: 99900, occurredAt: new Date(base + 13500).toISOString(),
  });
  const summary = await rpc<{ status: string }>(
    database, "authenti8_billing_summary", { userId },
  );
  assert.equal(summary.status, "PAST_DUE");
  await assertPastDueSubscriptionCannotBeReplaced(database, userId, organizationId);
}

async function assertInactiveWorkspace(database: PGlite, userId: string, organizationId: string) {
  const summary = await rpc<{ balance: number }>(
    database, "authenti8_billing_summary", { userId },
  );
  assert.equal(summary.balance, 0);
  const interviewId = await createInterview(database, organizationId, 100);
  const blocked = await rpc<{ reserved: boolean; reason: string }>(
    database, "authenti8_reserve_credit", { userId, interviewId },
  );
  assert.deepEqual(blocked, { reserved: false, reason: "INACTIVE_SUBSCRIPTION" });
  assert.deepEqual(await rpc(database, "authenti8_begin_checkout", {
    userId, purpose: "EXTRA_CREDITS", quantity: 1,
  }), { reason: "INACTIVE_SUBSCRIPTION" });
}

async function assertPastDueSubscriptionCannotBeReplaced(
  database: PGlite, userId: string, organizationId: string,
) {
  const checkout = await rpc<{ reason: string }>(database, "authenti8_begin_checkout", {
    userId, purpose: "PROFESSIONAL", quantity: 1,
  });
  assert.deepEqual(checkout, { reason: "EXISTING_SUBSCRIPTION" });
  assert.deepEqual(await rpc(database, "authenti8_billing_portal_context", { userId }),
    { subscriptionId: "subscription-3" });
  const current = await database.query<{ provider_subscription_id: string; status: string }>(
    "SELECT provider_subscription_id, status FROM subscriptions WHERE organization_id = $1",
    [organizationId],
  );
  assert.deepEqual(current.rows[0], {
    provider_subscription_id: "subscription-3", status: "PAST_DUE",
  });
}

async function establishCurrentSubscription(
  database: PGlite, userId: string, organizationId: string, base: number,
  dates: { periodStart: string; periodEnd: string },
) {
  await activateSecondSubscription(database, userId, organizationId, base, dates);
  await rpc(database, "authenti8_apply_billing_event", { eventId: "old-subscription-renewed",
    eventType: "subscription.active", organizationId, purpose: "PROFESSIONAL",
    quantity: 1, subscriptionId: "subscription-1",
    occurredAt: new Date(base + 9000).toISOString(), ...dates });
  const current = await database.query<{ provider_subscription_id: string }>(
    "SELECT provider_subscription_id FROM subscriptions WHERE organization_id = $1",
    [organizationId],
  );
  assert.equal(current.rows[0]?.provider_subscription_id, "subscription-2");
  await rpc(database, "authenti8_apply_billing_event", { eventId: "subscription-2-cancelled",
    eventType: "subscription.cancelled", organizationId, purpose: "PROFESSIONAL",
    quantity: 1, subscriptionId: "subscription-2",
    occurredAt: new Date(base + 9500).toISOString() });
  await rpc(database, "authenti8_apply_billing_event", { eventId: "unauthorized-active-3",
    eventType: "subscription.active", organizationId, purpose: "PROFESSIONAL",
    quantity: 1, subscriptionId: "subscription-3",
    occurredAt: new Date(base + 9750).toISOString(), ...dates });
  assert.equal((await rpc<{ plan: string }>(database,
    "authenti8_billing_summary", { userId })).plan, "STARTER");
  const checkout3 = await createProfessionalCheckout(database, userId, "subscription-3-session");
  await rpc(database, "authenti8_apply_billing_event", { eventId: "professional-active-3",
    eventType: "subscription.active", organizationId, purpose: "PROFESSIONAL",
    quantity: 1, subscriptionId: "subscription-3", checkoutIntentId: checkout3,
    occurredAt: new Date(base + 10000).toISOString(), ...dates });
  await rpc(database, "authenti8_apply_billing_event", { eventId: "old-subscription-cancelled",
    eventType: "subscription.cancelled", organizationId, purpose: "PROFESSIONAL",
    quantity: 1, subscriptionId: "subscription-2",
    occurredAt: new Date(base + 10500).toISOString() });
  assert.equal((await rpc<{ status: string }>(database,
    "authenti8_billing_summary", { userId })).status, "ACTIVE");
  await rpc(database, "authenti8_apply_billing_reversal", { eventId: "stale-professional-refund",
    eventType: "refund.succeeded", paymentId: "professional-payment-1",
    reversalId: "stale-professional-refund", amountMinor: 100000,
    occurredAt: new Date(base + 11000).toISOString() });
  assert.equal((await rpc<{ status: string }>(database,
    "authenti8_billing_summary", { userId })).status, "ACTIVE");
}

async function activateSecondSubscription(
  database: PGlite, userId: string, organizationId: string, base: number,
  dates: { periodStart: string; periodEnd: string },
) {
  const intent = await createProfessionalCheckout(database, userId, "subscription-2-session");
  await rpc(database, "authenti8_apply_billing_event", { eventId: "professional-active-2",
    eventType: "subscription.active", organizationId, purpose: "PROFESSIONAL",
    quantity: 1, subscriptionId: "subscription-2", checkoutIntentId: intent,
    occurredAt: new Date(base + 7000).toISOString(), ...dates });
  await rpc(database, "authenti8_apply_billing_event", { eventId: "professional-payment",
    eventType: "payment.succeeded", organizationId, purpose: "PROFESSIONAL", quantity: 1,
    subscriptionId: "subscription-2", paymentId: "professional-payment-1",
    checkoutIntentId: intent, checkoutSessionId: "subscription-2-session",
    amountMinor: 100000, currency: "USD", occurredAt: new Date(base + 8000).toISOString() });
  const activated = await database.query<{ status: string }>(
    "SELECT status FROM billing_checkout_sessions WHERE id = $1", [intent],
  );
  assert.equal(activated.rows[0]?.status, "ACTIVATED");
}

async function assertProfessionalCheckoutCompletion(
  database: PGlite, userId: string, organizationId: string, base: number,
) {
  const intent = await rpc<{ checkoutIntentId: string }>(database, "authenti8_begin_checkout", {
    userId, purpose: "PROFESSIONAL", quantity: 1,
  });
  await rpc(database, "authenti8_complete_checkout_intent", {
    userId, checkoutIntentId: intent.checkoutIntentId, sessionId: "checkout-professional",
  });
  assert.deepEqual(await rpc(database, "authenti8_pending_checkout_context", { userId }), {
    organizationId, checkoutIntentId: intent.checkoutIntentId,
    sessionId: "checkout-professional",
  });
  await rpc(database, "authenti8_apply_billing_event", { eventId: "professional-payment-early",
    eventType: "payment.succeeded", organizationId, purpose: "PROFESSIONAL", quantity: 1,
    subscriptionId: "subscription-1", paymentId: "professional-payment-early",
    checkoutSessionId: "checkout-professional", amountMinor: 100000, currency: "USD",
    occurredAt: new Date(base).toISOString() });
  assert.deepEqual(await rpc(database, "authenti8_billing_subscription_context", {
    subscriptionId: "subscription-1",
  }), { organizationId, checkoutIntentId: intent.checkoutIntentId,
    checkoutSessionId: "checkout-professional" });
  const result = await database.query<{ status: string }>(
    "SELECT status FROM billing_checkout_sessions WHERE id = $1", [intent.checkoutIntentId],
  );
  assert.equal(result.rows[0]?.status, "COMPLETED");
  assert.deepEqual(await rpc(database, "authenti8_pending_checkout_context", { userId }), {
    organizationId, checkoutIntentId: intent.checkoutIntentId,
    sessionId: "checkout-professional",
  });
  assert.deepEqual(await rpc(database, "authenti8_begin_checkout", {
    userId, purpose: "PROFESSIONAL", quantity: 1,
  }), { reason: "ACTIVATION_PENDING" });
  return intent.checkoutIntentId;
}
async function createExtraCheckout(
  database: PGlite, userId: string, quantity: number, sessionId: string,
) {
  const checkout = await rpc<{ checkoutIntentId: string }>(database, "authenti8_begin_checkout", {
    userId, purpose: "EXTRA_CREDITS", quantity,
  });
  await rpc(database, "authenti8_complete_checkout_intent", {
    userId, checkoutIntentId: checkout.checkoutIntentId, sessionId,
  });
  return checkout.checkoutIntentId;
}

async function createInterview(database: PGlite, organizationId: string, index: number) {
  const id = randomUUID();
  await database.query(`INSERT INTO interviews(id, organization_id, google_event_id,
    google_calendar_id, google_meet_code, google_meet_url, candidate_email,
    organizer_email, title, scheduled_start, scheduled_end)
    VALUES ($1, $2, $3, 'primary', $3, 'https://meet.google.com/abc-defg-hij',
      'candidate@example.com', 'owner@example.com', 'Interview', now(), now() + interval '1 hour')`,
  [id, organizationId, `event-${index}`]);
  return id;
}

async function rpc<T = unknown>(database: PGlite, name: string, input: object) {
  const result = await database.query<{ value: T }>(
    `SELECT ${name}($1::jsonb) AS value`, [JSON.stringify(input)],
  );
  return result.rows[0]!.value;
}
function organizationInput(userId: string) {
  return { userId, name: "Billing Co", domain: "billing.example.com",
    jobRole: "FOUNDER", companySize: "1-10", expectedMonthlyInterviews: 0,
    timezone: "UTC" };
}
function loadMigrations(lastFile?: string) {
  const directory = resolve(process.cwd(), "../../infrastructure/postgres");
  return readdirSync(directory).filter((file) => file.endsWith(".sql"))
    .filter((file) => !lastFile || file <= lastFile).sort()
    .map((file) => readFileSync(resolve(directory, file), "utf8")).join("\n");
}
