import assert from "node:assert/strict";
import test from "node:test";
import { BadGatewayException } from "@nestjs/common";
import { BillingInvoiceService } from "./billing-invoice.service.js";

test("invoice provider transport failures return a gateway error", async () => {
  const originalFetch = globalThis.fetch;
  const supabase = { rpc: async () => ({ paymentId: "pay_transport_failure" }) };
  const service = new BillingInvoiceService(supabase as never);
  const mutable = service as unknown as { config: { dodo: {
    apiKey: string; baseUrl: string } } };
  mutable.config.dodo.apiKey = "test-key";
  mutable.config.dodo.baseUrl = "https://test.dodopayments.com";
  globalThis.fetch = async () => { throw new TypeError("network unavailable"); };
  try {
    await assert.rejects(service.invoice("user-id", "pay_transport_failure"),
      (error: unknown) => error instanceof BadGatewayException
        && error.message === "The invoice provider is unavailable.");
  } finally { globalThis.fetch = originalFetch; }
});
