import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request } from "express";
import { hashToken } from "../auth/crypto.js";
import type { MailService } from "../auth/mail.service.js";
import type { SupabaseService } from "../supabase/supabase.service.js";
import { CandidateController } from "./candidate.controller.js";
import { InterviewLifecycleService } from "./interview-lifecycle.service.js";
import { isSupportedAgentVersion } from "./agent-version.js";

test("monitoring accepts only supported release versions", () => {
  assert.equal(isSupportedAgentVersion("WINDOWS", "0.1.0"), true);
  assert.equal(isSupportedAgentVersion("MACOS", "0.1.1"), true);
  assert.equal(isSupportedAgentVersion("WINDOWS", "0.0.9"), false);
  assert.equal(isSupportedAgentVersion("WINDOWS", "0.1.0-beta.1"), false);
  assert.equal(isSupportedAgentVersion("CHROME", "99.0.0"), false);
});

test("the lifecycle drain clears more than ten concurrently due deliveries", async () => {
  const jobs = Array.from({ length: 12 }, (_, index) => deliveryJob(index));
  let claimIndex = 0;
  const supabase = {
    rpc: async (name: string) => {
      if (name === "authenti8_orchestrate_interviews") return { protected: 0, scheduled: 0 };
      if (name === "authenti8_orchestrate_monitoring") {
        return { interruptionsOpened: 0, sessionsStopped: 0 };
      }
      if (name === "authenti8_claim_verification_delivery") return jobs[claimIndex++] ?? null;
      if (name === "authenti8_complete_verification_delivery") return { completed: true };
      throw new Error(`Unexpected RPC: ${name}`);
    },
  } as unknown as SupabaseService;
  const mail = {
    usesDurableOutbox: true,
    prepareOutbox: () => ({ encryptedToken: "ciphertext" }),
  } as unknown as MailService;
  const result = await new InterviewLifecycleService(supabase, mail).drain();
  assert.equal(result.delivered, 12);
  assert.equal(claimIndex, 13);
});

test("candidate requests consume the token quota before the shared IP quota", async () => {
  const consumed: string[] = [];
  const supabase = {
    rpc: async (name: string, input: Record<string, unknown>) => {
      if (name === "authenti8_consume_rate_limit") consumed.push(String(input.keyHash));
      return name === "authenti8_consume_rate_limit" ? 1 : undefined;
    },
  } as unknown as SupabaseService;
  const lifecycle = {
    verification: async () => ({ valid: true }),
  } as unknown as InterviewLifecycleService;
  const controller = new CandidateController(lifecycle, supabase);
  const token = "a".repeat(32);
  await controller.verification({ token }, { ip: "203.0.113.9" } as Request);
  assert.deepEqual(consumed, [
    hashToken(`candidate:lookup:token:${hashToken(token)}`),
    hashToken("ip:203.0.113.9:candidate:lookup"),
  ]);
});

function deliveryJob(index: number) {
  return {
    interviewId: `interview-${index}`,
    candidateEmail: `candidate-${index}@example.com`,
    claimToken: `claim-${index}`,
    attempts: 1,
  };
}
