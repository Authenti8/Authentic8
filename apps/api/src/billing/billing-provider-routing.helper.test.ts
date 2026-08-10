import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

export async function advanceToDeviceConnecting(database: PGlite, interviewId: string) {
  for (const [expected, destination] of [
    ["DETECTED", "PROTECTED"], ["PROTECTED", "VERIFICATION_SCHEDULED"],
    ["VERIFICATION_SCHEDULED", "WAITING_FOR_CANDIDATE"],
    ["WAITING_FOR_CANDIDATE", "CONSENT_PENDING"],
    ["CONSENT_PENDING", "DEVICE_CONNECTING"],
  ]) {
    await database.query("SELECT authenti8_transition_interview($1, ARRAY[$2], $3, 'TEST')",
      [interviewId, expected, destination]);
  }
  await database.query(`INSERT INTO verification_sessions(
    interview_id, candidate_email, status, consent_version, consented_at,
    eligible_start, eligible_end
  ) SELECT id, candidate_email, 'CONSENTED', authenti8_current_consent_version(), now(),
    scheduled_start - interval '15 minutes', scheduled_end + interval '30 minutes'
    FROM interviews WHERE id = $1`, [interviewId]);
}

export async function assertEnterpriseCannotBuyExtras(
  database: PGlite, userId: string, organizationId: string,
) {
  await database.query(
    "UPDATE subscriptions SET plan_key = 'ENTERPRISE', status = 'ACTIVE' WHERE organization_id = $1",
    [organizationId],
  );
  assert.deepEqual(await rpc(database, "authenti8_begin_checkout", {
    userId, purpose: "EXTRA_CREDITS", quantity: 1,
  }), { reason: "UNSUPPORTED_PLAN" });
  await database.query(
    "UPDATE subscriptions SET plan_key = 'STARTER', status = 'ACTIVE' WHERE organization_id = $1",
    [organizationId],
  );
}

export async function assertPendingPaymentBindsSubscription(
  database: PGlite, userId: string, organizationId: string,
) {
  const checkout = await rpc<{ checkoutIntentId: string }>(database, "authenti8_begin_checkout", {
    userId, purpose: "PROFESSIONAL", quantity: 1,
  });
  const decoy = await database.query<{ id: string }>(
    `INSERT INTO billing_checkout_sessions(organization_id, provider, provider_session_id,
      purpose, quantity) VALUES ($1, 'DODO', 'newer-unpaid-session', 'PROFESSIONAL', 1)
      RETURNING id`, [organizationId],
  );
  await rpc(database, "authenti8_apply_billing_event", {
    eventId: "pending-intent-payment", eventType: "payment.succeeded", organizationId,
    purpose: "PROFESSIONAL", quantity: 1, subscriptionId: "pending-intent-subscription",
    checkoutIntentId: checkout.checkoutIntentId, paymentId: "pending-intent-payment",
    amountMinor: 100000, currency: "USD", occurredAt: new Date().toISOString(),
  });
  const context = await rpc(database, "authenti8_billing_subscription_context", {
    subscriptionId: "pending-intent-subscription",
  });
  assert.equal((context as { checkoutIntentId?: string }).checkoutIntentId,
    checkout.checkoutIntentId);
  await database.query("DELETE FROM billing_provider_payments WHERE payment_id = $1",
    ["pending-intent-payment"]);
  await database.query("DELETE FROM billing_provider_subscriptions WHERE provider_subscription_id = $1",
    ["pending-intent-subscription"]);
  await database.query("DELETE FROM billing_webhook_events WHERE event_id = $1",
    ["pending-intent-payment"]);
  await database.query("DELETE FROM billing_checkout_sessions WHERE id = $1",
    [checkout.checkoutIntentId]);
  await database.query("DELETE FROM billing_checkout_sessions WHERE id = $1",
    [decoy.rows[0]!.id]);
}

export async function assertNewCheckoutSupersedesRecovery(
  database: PGlite, userId: string, organizationId: string, base: number,
  dates: { periodStart: string; periodEnd: string },
) {
  const checkoutIntentId = await createProfessionalCheckout(
    database, userId, "superseding-checkout-session",
  );
  const result = await rpc(database, "authenti8_apply_dunning_recovery", {
    eventId: "stale-dunning-after-new-checkout", subscriptionId: "subscription-1",
    occurredAt: new Date(base + 6750).toISOString(), ...dates,
  });
  assert.deepEqual(result, { ignored: true, reason: "SUPERSEDED_SUBSCRIPTION" });
  assert.equal((await rpc<{ plan: string }>(database,
    "authenti8_billing_summary", { userId })).plan, "STARTER");
  assert.deepEqual(await rpc(database, "authenti8_apply_billing_event", {
    eventId: "stale-renewal-after-new-checkout", eventType: "subscription.renewed",
    organizationId, purpose: "PROFESSIONAL", quantity: 1,
    subscriptionId: "subscription-1", occurredAt: new Date(base + 6800).toISOString(), ...dates,
  }), { ignored: true, reason: "UNAUTHORIZED_CHECKOUT" });
  assert.equal((await rpc<{ plan: string }>(database,
    "authenti8_billing_summary", { userId })).plan, "STARTER");
  await rpc(database, "authenti8_fail_checkout_intent", { userId, checkoutIntentId });
  const provider = await database.query<{ checkout_intent_id: string; organization_id: string }>(
    `SELECT checkout_intent_id, organization_id FROM billing_provider_subscriptions
      WHERE provider_subscription_id = 'subscription-1'`,
  );
  assert.notEqual(provider.rows[0]?.checkout_intent_id, checkoutIntentId);
  assert.equal(provider.rows[0]?.organization_id, organizationId);
}

export async function createProfessionalCheckout(
  database: PGlite, userId: string, sessionId: string,
) {
  const checkout = await rpc<{ checkoutIntentId: string }>(database, "authenti8_begin_checkout", {
    userId, purpose: "PROFESSIONAL", quantity: 1,
  });
  await rpc(database, "authenti8_complete_checkout_intent", {
    userId, checkoutIntentId: checkout.checkoutIntentId, sessionId,
  });
  return checkout.checkoutIntentId;
}

async function rpc<T = unknown>(database: PGlite, name: string, input: object) {
  const result = await database.query<{ value: T }>(
    `SELECT ${name}($1::jsonb) AS value`, [JSON.stringify(input)],
  );
  return result.rows[0]!.value;
}
