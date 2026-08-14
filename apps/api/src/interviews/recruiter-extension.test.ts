import assert from "node:assert/strict";
import test from "node:test";
import { firstValueFrom, lastValueFrom } from "rxjs";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import type { RateLimiterService } from "../auth/rate-limiter.service.js";
import { RecruiterExtensionController } from "./recruiter-extension.controller.js";
import type { RecruiterExtensionService } from "./recruiter-extension.service.js";
import { RecruiterExtensionService as ExtensionService } from "./recruiter-extension.service.js";
import type { SupabaseService } from "../supabase/supabase.service.js";

test("recruiter extension tokens consume a user-bound issuance quota", async () => {
  const calls: string[] = [];
  const extension = { issue: async () => { calls.push("issue"); return { token: "token" }; } } as
    unknown as RecruiterExtensionService;
  const limiter = { consume: async (key: string, limit: number, windowMs: number) => {
    calls.push(`${key}:${limit}:${windowMs}`);
  } } as unknown as RateLimiterService;
  const controller = new RecruiterExtensionController(extension, limiter);
  const request = { session: { userId: "123e4567-e89b-12d3-a456-426614174000" } } as
    unknown as AuthenticatedRequest;
  await controller.issue(request, { organizationId: "123e4567-e89b-12d3-a456-426614174001" });
  assert.deepEqual(calls, [
    "recruiter-extension:token:123e4567-e89b-12d3-a456-426614174000:12:900000", "issue",
  ]);
});

test("a valid extension credential can refresh without an open dashboard", async () => {
  const calls: string[] = [];
  const supabase = { rpc: async (name: string) => {
    calls.push(name);
    if (name === "authenti8_rotate_recruiter_token") return { rotated: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString() };
    throw new Error(`Unexpected RPC: ${name}`);
  } } as unknown as SupabaseService;
  const refreshed = await new ExtensionService(supabase).refresh(`Bearer ${"a".repeat(32)}`);
  assert.equal(typeof refreshed.token, "string");
  assert.deepEqual(calls, ["authenti8_rotate_recruiter_token"]);
});

test("live streams stop at the token expiry without polling token state for every log", async () => {
  let resolutions = 0;
  const supabase = { rpc: async (name: string) => {
    if (name === "authenti8_resolve_recruiter_token") {
      resolutions += 1;
      return { valid: true, userId: "user", organizationId: "org",
        expiresAt: new Date(Date.now() + 50).toISOString() };
    }
    if (name === "authenti8_recruiter_logs") return { authorized: true, events: [] };
    throw new Error(`Unexpected RPC: ${name}`);
  } } as unknown as SupabaseService;
  const service = new ExtensionService(supabase);
  await lastValueFrom(service.events(`Bearer ${"a".repeat(32)}`,
    "123e4567-e89b-12d3-a456-426614174000", 0));
  assert.equal(resolutions, 1);
});

test("concurrent live streams share polling while retaining their own cursors", async () => {
  let logRequests = 0;
  const cursors: number[] = [];
  const supabase = { rpc: async (name: string, input: Record<string, unknown>) => {
    if (name === "authenti8_resolve_recruiter_token") return { valid: true, userId: "user",
      organizationId: "org", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    if (name === "authenti8_recruiter_logs") { logRequests += 1; cursors.push(Number(input.after));
      const event = (sequence: number) => ({ sequence, kind: "MONITORING_ACTIVE",
        message: `Monitoring active ${sequence}`, occurredAt: new Date().toISOString(), metadata: {} });
      return { authorized: true, events: [event(5), event(20)] }; }
    throw new Error(`Unexpected RPC: ${name}`);
  } } as unknown as SupabaseService;
  const service = new ExtensionService(supabase);
  const stream = (after: number) => firstValueFrom(service.events(`Bearer ${"a".repeat(32)}`,
    "123e4567-e89b-12d3-a456-426614174000", after));
  const events = await Promise.all([stream(4), stream(19)]);
  assert.equal(logRequests, 1);
  assert.deepEqual(cursors, [4]);
  assert.deepEqual(events.map((event) => event.data.sequence).sort((left, right) =>
    Number(left) - Number(right)), [5, 20]);
});

test("a subscriber joining an in-flight poll catches up from its own cursor", async () => {
  let release!: () => void; let started!: () => void; let logRequests = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pollStarted = new Promise<void>((resolve) => { started = resolve; });
  const event = (sequence: number) => ({ sequence, kind: "MONITORING_ACTIVE",
    message: `Event ${sequence}`, occurredAt: new Date().toISOString(), metadata: {} });
  const supabase = { rpc: async (name: string) => {
    if (name === "authenti8_resolve_recruiter_token") return { valid: true, userId: "user",
      organizationId: "org", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    if (name === "authenti8_recruiter_logs") {
      logRequests += 1;
      if (logRequests === 1) {
        started(); await gate;
        return { authorized: true, events: Array.from({ length: 500 }, (_, index) =>
          event(index + 101)) };
      }
      return { authorized: true, events: [event(1)] };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  } } as unknown as SupabaseService;
  const service = new ExtensionService(supabase); const token = `Bearer ${"a".repeat(32)}`;
  const first = firstValueFrom(service.events(token, "123e4567-e89b-12d3-a456-426614174000", 100));
  await pollStarted;
  const late = firstValueFrom(service.events(token, "123e4567-e89b-12d3-a456-426614174000", 0));
  release();
  assert.equal((await first).data.sequence, 101);
  assert.equal((await late).data.sequence, 1);
  assert.equal(logRequests, 2);
});

test("a stale failed poll cannot remove a replacement feed", async () => {
  let releaseOld!: () => void; let oldStarted!: () => void;
  let releaseNew!: () => void; let newStarted!: () => void; let calls = 0;
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  const oldReady = new Promise<void>((resolve) => { oldStarted = resolve; });
  const newGate = new Promise<void>((resolve) => { releaseNew = resolve; });
  const newReady = new Promise<void>((resolve) => { newStarted = resolve; });
  const supabase = { rpc: async (name: string) => {
    if (name === "authenti8_resolve_recruiter_token") return { valid: true, userId: "user",
      organizationId: "org", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    if (name === "authenti8_recruiter_logs" && ++calls === 1) {
      oldStarted(); await oldGate; throw new Error("stale poll failed");
    }
    if (name === "authenti8_recruiter_logs") {
      newStarted(); await newGate;
      return { authorized: true, events: [{ sequence: 1, kind: "MONITORING_ACTIVE",
        message: "Active", occurredAt: new Date().toISOString(), metadata: {} }] };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  } } as unknown as SupabaseService;
  const service = new ExtensionService(supabase); const token = `Bearer ${"a".repeat(32)}`;
  const old = service.events(token, "123e4567-e89b-12d3-a456-426614174000", 0)
    .subscribe({ error: () => undefined });
  await oldReady; old.unsubscribe();
  const replacement = firstValueFrom(service.events(token,
    "123e4567-e89b-12d3-a456-426614174000", 0));
  await newReady; releaseOld(); await new Promise((resolve) => setTimeout(resolve, 0));
  const feeds = (service as unknown as { feeds: Map<string, unknown> }).feeds;
  assert.equal(feeds.size, 1);
  releaseNew(); assert.equal((await replacement).data.sequence, 1);
});
