import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseService } from "../supabase/supabase.service.js";
import { OperationalFailureService } from "./operational-failure.service.js";

test("operational failures use redacted stable identifiers", async () => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const supabase = { rpc: async (name: string, input: Record<string, unknown>) => {
    calls.push({ name, input }); return { recorded: true };
  } } as unknown as SupabaseService;
  const service = new OperationalFailureService(supabase);
  await service.record({ component: "TELEMETRY_INGESTION", errorCode: "RPC_FAILED",
    safeMessage: "Telemetry ingestion failed.", reference: "private-session-id",
    context: { eventType: "HEARTBEAT" } });
  assert.equal(calls[0]?.name, "authenti8_record_operational_failure");
  assert.equal(calls[0]?.input.component, "TELEMETRY_INGESTION");
  assert.match(String(calls[0]?.input.idempotencyKey), /^telemetry_ingestion:[a-f0-9]{64}$/);
  assert.doesNotMatch(String(calls[0]?.input.idempotencyKey), /private-session-id/);
  await service.record({ component: "TELEMETRY_INGESTION", errorCode: "RPC_FAILED",
    safeMessage: "Telemetry ingestion failed again.", reference: "private-session-id",
    context: { eventType: "HEARTBEAT" } });
  assert.equal(calls[1]?.input.idempotencyKey, calls[0]?.input.idempotencyKey);
});

test("observability failures never replace the originating failure", async () => {
  const supabase = { rpc: async () => { throw new Error("observability unavailable"); } } as
    unknown as SupabaseService;
  const service = new OperationalFailureService(supabase);
  await assert.doesNotReject(service.record({ component: "LIVE_STREAM",
    errorCode: "POLL_FAILED", safeMessage: "Live polling failed.", reference: "interview" }));
});
