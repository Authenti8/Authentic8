import type { TelemetryEnvelope } from "@authenti8/event-schemas";
import { AgentHttpClient } from "./http-client.js";
import { saveIdentity } from "./keychain.js";
import type { MacosIdentity } from "./types.js";

export class TelemetryDelivery {
  private retryAt = 0;
  private failures = 0;

  constructor(private readonly client: AgentHttpClient, private readonly token: string,
    private readonly identity: MacosIdentity,
    private readonly persist: typeof saveIdentity = saveIdentity) {}

  async enqueue(event: TelemetryEnvelope, chainState: MacosIdentity["chainState"],
    monitoringStarted = this.identity.monitoringStarted) {
    const pending = this.identity.pendingEvents ?? [];
    if (pending.length >= 1_000) throw new Error("Encrypted telemetry queue capacity exceeded.");
    pending.push(event);
    this.identity.pendingEvents = pending;
    this.identity.chainState = chainState;
    this.identity.monitoringStarted = monitoringStarted;
    await this.persist(this.token, this.identity);
  }

  async flush(force = false) {
    if (!force && Date.now() < this.retryAt) return false;
    while (this.identity.pendingEvents?.length) {
      try {
        await this.client.post("agent/telemetry", this.identity.pendingEvents[0]);
        this.identity.pendingEvents.shift();
        this.failures = 0;
        await this.persist(this.token, this.identity);
      } catch {
        this.failures += 1;
        this.retryAt = Date.now() + backoff(this.failures);
        return false;
      }
    }
    return true;
  }

  async flushUntil(deadline: number) {
    while (this.identity.pendingEvents?.length && Date.now() < deadline) {
      if (await this.flush(true)) return true;
      await delay(Math.min(5_000, Math.max(250, deadline - Date.now())));
    }
    return !this.identity.pendingEvents?.length;
  }
}

function backoff(attempt: number) {
  const ceiling = Math.min(30_000, 500 * (2 ** Math.min(attempt, 6)));
  return Math.floor(ceiling * (0.75 + Math.random() * 0.5));
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
