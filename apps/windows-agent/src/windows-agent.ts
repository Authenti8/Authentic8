import { AgentHttpClient } from "./http-client.js";
import { collectAudioEndpoints } from "./audio-sensor.js";
import { validateConfiguration } from "./config.js";
import { loadOrEnrollDevice } from "./enrollment-client.js";
import { EventChain } from "./event-chain.js";
import { collectProcesses } from "./process-sensor.js";
import { audioChanges, processChanges, windowChanges } from "./snapshot-diff.js";
import type { AgentConfiguration, EnrolledIdentity, SensorSnapshot } from "./types.js";
import { collectWindows } from "./window-sensor.js";
import { matchSnapshot } from "./detection-matcher.js";
import { verifyRulePack } from "./rule-pack-verifier.js";
import { removeIdentity } from "./credential-store.js";
import { acknowledgeBrowserEvidence, claimBrowserEvidence } from "./browser-evidence-spool.js";
import { TelemetryDelivery } from "./telemetry-delivery.js";

export class WindowsAgent {
  private stopped = false;
  private snapshot: SensorSnapshot = { processes: [], windows: [], audioEndpoints: [] };
  private readonly emittedSignals = new Set<string>();
  private scanAt = { processes: 0, windows: 0, audio: 0, heartbeat: 0 };
  private baselineCaptured = false;
  private ruleRefreshAt = 0;
  private browserEvidenceDueAt = 0;
  private browserUnavailableSent = false;

  constructor(private readonly config: AgentConfiguration) {
    validateConfiguration(config);
    if (config.rulePack && !config.rulePackPublicKey) {
      throw new Error("A signed detection rule pack requires its verification key.");
    }
    if (config.rulePack) verifyRulePack(config.rulePack, config.rulePackPublicKey!);
  }

  async run() {
    assertSupportedPlatform();
    const identity = await loadOrEnrollDevice(this.config);
    const client = new AgentHttpClient(this.config.apiOrigin);
    const chain = new EventChain({ sessionId: identity.verificationSessionId,
      privateKey: identity.privateKey, agentVersion: this.config.agentVersion,
      rulePackVersion: this.config.rulePackVersion }, identity.chainState);
    const delivery = new TelemetryDelivery(client, this.config.enrollmentToken, identity);
    const send = async (event: ReturnType<EventChain["create"]>) => {
      identity.chainState = chain.state(); await delivery.enqueue(event); await delivery.flush();
    };
    await delivery.flush(true);
    if (identity.pendingEvents?.some((event) => event.eventType === "MONITORING_STOPPED")) {
      await delivery.flushUntil(Date.now() + 30_000);
      if (!identity.pendingEvents.length) await removeIdentity(this.config.enrollmentToken);
      return;
    }
    await this.waitForEligibleStart(Date.parse(identity.eligibleStart), Date.parse(identity.eligibleEnd));
    if (this.stopped) return;
    if (Date.now() >= Date.parse(identity.eligibleEnd)) {
      await removeIdentity(this.config.enrollmentToken); return;
    }
    await this.refreshRulePack(chain);
    if (!identity.monitoringStarted) {
      await send(chain.create("MONITORING_STARTED", { deviceId: identity.deviceId }));
      if (!await delivery.flushUntil(Date.now() + 30_000)) {
        throw new Error("Monitoring start could not be acknowledged.");
      }
    }
    await this.monitor(chain, send, delivery, identity, Date.parse(identity.eligibleEnd));
    await send(chain.create("MONITORING_STOPPED",
      { reason: this.stopped ? "CANDIDATE_ENDED" : "AUTHORIZED_STOP" }));
    const delivered = await delivery.flushUntil(Date.now() + 5 * 60_000);
    if (delivered) await removeIdentity(this.config.enrollmentToken);
  }

  stop() { this.stopped = true; }

  private async waitForEligibleStart(eligibleStart: number, eligibleEnd: number) {
    while (!this.stopped && Date.now() < eligibleStart && Date.now() < eligibleEnd) {
      await delay(Math.min(1_000, eligibleStart - Date.now()));
    }
  }

  private async refreshRulePack(chain: EventChain) {
    if (Date.now() < this.ruleRefreshAt) return;
    const pack = this.config.refreshRulePack
      ? await this.config.refreshRulePack() : this.config.rulePack;
    if (!pack) throw new Error("A signed detection rule pack is required.");
    verifyRulePack(pack, this.config.rulePackPublicKey!);
    const refreshAt = Date.parse(pack.expiresAt) - 60_000;
    if (refreshAt <= Date.now()) throw new Error("Detection rules expire too soon to monitor safely.");
    this.config.rulePack = pack;
    this.config.rulePackVersion = pack.version;
    chain.setRulePackVersion(pack.version);
    this.ruleRefreshAt = refreshAt;
  }

  private async monitor(chain: EventChain, send: Sender, delivery: TelemetryDelivery,
    identity: EnrolledIdentity, eligibleEnd: number) {
    const intervals = this.config.pollIntervals ?? {};
    const collectionDeadline = eligibleEnd;
    this.browserEvidenceDueAt = Date.now() + 45_000;
    while (!this.stopped && Date.now() < collectionDeadline) {
      await this.refreshRulePack(chain);
      await this.collectAndSend(chain, send, intervals, collectionDeadline);
      await this.transferBrowserEvidence(chain, send, delivery, identity, collectionDeadline);
      if (Date.now() < collectionDeadline && Date.now() >= this.scanAt.heartbeat) {
        await send(chain.create("HEARTBEAT", { status: "MONITORING_ACTIVE" }));
        this.scanAt.heartbeat = Date.now() + 5_000;
      }
      await delay(500);
    }
  }

  private async transferBrowserEvidence(chain: EventChain, send: Sender,
    delivery: TelemetryDelivery, identity: EnrolledIdentity, deadline: number) {
    const claim = await claimBrowserEvidence();
    if (!claim) {
      if (browserEvidenceUnavailable(this.browserEvidenceDueAt, this.browserUnavailableSent)
        && Date.now() < deadline) {
        await send(chain.create("PERMISSION_CHANGED", { sensor: "BROWSER", available: false,
          required: true, reason: "EXTENSION_DISABLED" }));
        this.browserUnavailableSent = true;
      }
      return;
    }
    this.browserEvidenceDueAt = Date.now() + 45_000;
    this.browserUnavailableSent = false;
    const prior = identity.browserEvidenceClaim;
    const start = prior?.claimId === claim.claimId ? prior.nextIndex : 0;
    for (let index = start; index < claim.evidence.length && Date.now() < deadline; index += 1) {
      const evidence = claim.evidence[index]!;
      const event = chain.create(evidence.eventType, evidence.payload);
      await delivery.enqueueClaimed(event, claim.claimId, index + 1, chain.state());
    }
    if (identity.browserEvidenceClaim?.nextIndex !== claim.evidence.length) return;
    if (await acknowledgeBrowserEvidence(claim.claimId)) await delivery.completeBrowserClaim();
  }

  private async collectAndSend(
    chain: EventChain, send: Sender, intervals: Intervals, deadline: number,
  ) {
    const now = Date.now();
    const [processResult, windowResult, audioResult] = await Promise.all([
      collectIfDue(now >= this.scanAt.processes, collectProcesses, this.snapshot.processes, "PROCESS"),
      collectIfDue(now >= this.scanAt.windows, collectWindows, this.snapshot.windows, "WINDOW"),
      collectIfDue(now >= this.scanAt.audio, collectAudioEndpoints,
        this.snapshot.audioEndpoints, "AUDIO"),
    ]);
    for (const result of [processResult, windowResult, audioResult]) {
      if (Date.now() < deadline && result.error) await send(chain.create("PERMISSION_CHANGED",
        { sensor: result.sensor, available: false, reason: result.error }));
    }
    const processes = processResult.value;
    const windows = windowResult.value;
    const audioEndpoints = audioResult.value;
    if (!this.baselineCaptured) {
      this.snapshot = { processes, windows, audioEndpoints };
      this.baselineCaptured = true;
      this.advanceSchedule(now, intervals);
      await this.sendDetectionSignals(chain, send, deadline);
      return;
    }
    for (const payload of processChanges(this.snapshot.processes, processes)) {
      if (Date.now() >= deadline) break;
      const eventType = payload.change === "STARTED" ? "PROCESS_STARTED"
        : payload.change === "STOPPED" ? "PROCESS_STOPPED" : "PROCESS_OBSERVED";
      await send(chain.create(eventType, { ...payload }));
    }
    for (const payload of windowChanges(this.snapshot.windows, windows)) {
      if (Date.now() >= deadline) break;
      const existed = this.snapshot.windows.some((item) => item.windowIdHash === payload.windowIdHash);
      await send(chain.create(existed ? "WINDOW_CHANGED" : "WINDOW_CREATED", { ...payload }));
    }
    for (const payload of audioChanges(this.snapshot.audioEndpoints, audioEndpoints)) {
      if (Date.now() >= deadline) break;
      const eventType = payload.change === "ADDED" ? "AUDIO_DEVICE_ADDED" : "AUDIO_ROUTE_CHANGED";
      await send(chain.create(eventType, { ...payload }));
    }
    this.snapshot = { processes, windows, audioEndpoints };
    this.advanceSchedule(now, intervals);
    await this.sendDetectionSignals(chain, send, deadline);
  }

  private advanceSchedule(now: number, intervals: Intervals) {
    if (now >= this.scanAt.processes) this.scanAt.processes = now + (intervals.processes ?? 3_000);
    if (now >= this.scanAt.windows) this.scanAt.windows = now + (intervals.windows ?? 1_500);
    if (now >= this.scanAt.audio) this.scanAt.audio = now + (intervals.audio ?? 3_000);
  }

  private async sendDetectionSignals(chain: EventChain, send: Sender, deadline: number) {
    for (const signal of matchSnapshot(this.snapshot, this.config.rulePack)) {
      if (Date.now() >= deadline) break;
      const key = JSON.stringify(signal);
      if (this.emittedSignals.has(key)) continue;
      this.emittedSignals.add(key);
      const eventType = signal.confidence === "HIGH"
        && signal.activeUseEvidence.includes("TOOL_OWNED_OVERLAY")
        ? "HIDDEN_OVERLAY_MATCH" : "KNOWN_PROCESS_MATCH";
      await send(chain.create(eventType, { ...signal }));
    }
  }
}

export function browserEvidenceUnavailable(dueAt: number, alreadyReported: boolean,
  now = Date.now()) {
  return !alreadyReported && dueAt > 0 && now >= dueAt;
}

function assertSupportedPlatform() {
  if (process.platform !== "win32") throw new Error("Authenti8 Verify supports Windows 11 only.");
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.max(500, milliseconds)));
}

type Sender = (event: ReturnType<EventChain["create"]>) => Promise<void>;
type Intervals = NonNullable<AgentConfiguration["pollIntervals"]>;

async function collectIfDue<T>(due: boolean, collect: () => Promise<T>, fallback: T, sensor: string) {
  if (!due) return { value: fallback, sensor };
  try { return { value: await collect(), sensor }; }
  catch (error) { return { value: fallback, sensor,
    error: error instanceof Error ? error.message.slice(0, 300) : "Sensor unavailable" }; }
}
