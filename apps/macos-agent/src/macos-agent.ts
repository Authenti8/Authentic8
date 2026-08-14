import { AgentHttpClient } from "./http-client.js";
import { validateConfiguration } from "./config.js";
import { TelemetryDelivery } from "./delivery.js";
import { loadOrEnroll } from "./enrollment.js";
import { MacosEventChain } from "./event-chain.js";
import { removeIdentity } from "./keychain.js";
import { matchMacosSnapshot } from "./matcher.js";
import { verifyMacosRulePack } from "./rule-pack.js";
import { collectMacosSnapshot } from "./sensor.js";
import type { MacosAgentConfiguration, MacosSnapshot } from "./types.js";

export class MacosAgent {
  private stopped = false;
  private ruleRefreshAt = 0;

  constructor(private readonly config: MacosAgentConfiguration) {
    validateConfiguration(config);
    verifyMacosRulePack(config.rulePack, config.rulePackPublicKey);
  }

  stop() { this.stopped = true; }

  async run() {
    if (process.platform !== "darwin") throw new Error("Authenti8 Verify for macOS requires macOS.");
    const identity = await loadOrEnroll(this.config);
    const end = Date.parse(identity.eligibleEnd);
    const delivery = new TelemetryDelivery(new AgentHttpClient(this.config.apiOrigin),
      this.config.enrollmentToken, identity);
    const recoveringStop = identity.pendingEvents?.some(
      (event) => event.eventType === "MONITORING_STOPPED") === true;
    await delivery.flush(true);
    if (recoveringStop) {
      const delivered = await delivery.flushUntil(Date.now() + 30_000);
      if (delivered) await removeIdentity(this.config.enrollmentToken);
      return;
    }
    await this.waitUntil(Date.parse(identity.eligibleStart), end);
    if (this.stopped || Date.now() >= end) return removeIdentity(this.config.enrollmentToken);
    await this.refreshRules();
    const chain = new MacosEventChain({ sessionId: identity.verificationSessionId,
      privateKey: identity.privateKey, agentVersion: this.config.agentVersion,
      rulePackVersion: this.config.rulePack.version }, identity.chainState);
    if (!identity.monitoringStarted) {
      const event = chain.create("MONITORING_STARTED", { deviceId: identity.deviceId });
      await delivery.enqueue(event, chain.state(), true);
      if (!await delivery.flush(true)) throw new Error("Monitoring start could not be acknowledged.");
    }
    await this.monitor(chain, delivery, end);
    const reason = this.stopped ? "CANDIDATE_ENDED" : "AUTHORIZED_STOP";
    const stopped = chain.create("MONITORING_STOPPED", { reason });
    await delivery.enqueue(stopped, chain.state());
    const delivered = await delivery.flushUntil(Date.now() + 5 * 60_000);
    if (delivered) await removeIdentity(this.config.enrollmentToken);
  }

  private async monitor(chain: MacosEventChain, delivery: TelemetryDelivery, end: number) {
    let previous: MacosSnapshot | undefined;
    let heartbeatAt = 0;
    while (!this.stopped && Date.now() < end) {
      if (await this.refreshRules(chain)) previous = undefined;
      const snapshot = await collectMacosSnapshot(this.config.sensorPath, previous?.applications);
      for (const evidence of evidenceChanges(previous, snapshot, this.config.rulePack)) {
        const event = chain.create(evidence.eventType, evidence.payload);
        await delivery.enqueue(event, chain.state());
      }
      if (Date.now() >= heartbeatAt) {
        const heartbeat = chain.create("HEARTBEAT", { status: "MONITORING_ACTIVE" });
        await delivery.enqueue(heartbeat, chain.state());
        heartbeatAt = Date.now() + 5_000;
      }
      await delivery.flush(); previous = snapshot; await delay(1_000);
    }
  }

  private async waitUntil(start: number, end: number) {
    while (!this.stopped && Date.now() < start && Date.now() < end) await delay(1_000);
  }

  private async refreshRules(chain?: MacosEventChain) {
    if (Date.now() < this.ruleRefreshAt) return false;
    const previousVersion = this.config.rulePack.version;
    const pack = this.config.refreshRulePack
      ? await this.config.refreshRulePack() : this.config.rulePack;
    verifyMacosRulePack(pack, this.config.rulePackPublicKey);
    const refreshAt = Date.parse(pack.expiresAt) - 60_000;
    if (refreshAt <= Date.now()) throw new Error("Detection rules expire too soon to monitor safely.");
    this.config.rulePack = pack; this.ruleRefreshAt = refreshAt;
    chain?.setRulePackVersion(pack.version);
    return pack.version !== previousVersion;
  }
}

export function evidenceChanges(previous: MacosSnapshot | undefined, current: MacosSnapshot,
  pack: MacosAgentConfiguration["rulePack"]) {
  const events: Evidence[] = [];
  for (const permission of ["accessibility", "screenRecording"] as const) {
    if (!previous || previous.permissions[permission] !== current.permissions[permission]) {
      events.push({ eventType: "PERMISSION_CHANGED", payload: { sensor: permission.toUpperCase(),
        available: current.permissions[permission], required: true } });
    }
  }
  const priorPids = new Set(previous?.applications.map((item) => item.processId) ?? []);
  const currentPids = new Set(current.applications.map((item) => item.processId));
  for (const app of current.applications.filter((item) => !priorPids.has(item.processId))) {
    events.push({ eventType: "PROCESS_STARTED", payload: publicApplication(app) });
  }
  for (const app of previous?.applications.filter((item) => !currentPids.has(item.processId)) ?? []) {
    events.push({ eventType: "PROCESS_STOPPED", payload: publicApplication(app) });
  }
  events.push(...windowChanges(previous?.windows ?? [], current.windows));
  events.push(...audioChanges(previous?.audioDevices ?? [], current.audioDevices));
  const priorMatches = new Set(previous ? matchMacosSnapshot(previous, pack).map(matchKey) : []);
  for (const match of matchMacosSnapshot(current, pack)) {
    if (priorMatches.has(matchKey(match))) continue;
    events.push({ eventType: match.confirmed ? "HIDDEN_OVERLAY_MATCH" : "KNOWN_PROCESS_MATCH",
      payload: { ...match } });
  }
  return events;
}

function windowChanges(previous: MacosSnapshot["windows"], current: MacosSnapshot["windows"]) {
  const events: Evidence[] = []; const prior = new Map(previous.map((item) => [item.windowIdHash, item]));
  const active = new Set(current.map((item) => item.windowIdHash));
  for (const window of current) {
    const before = prior.get(window.windowIdHash);
    if (!before) events.push({ eventType: "WINDOW_CREATED", payload: { ...window } });
    else if (JSON.stringify(before) !== JSON.stringify(window)) {
      events.push({ eventType: "WINDOW_CHANGED", payload: { ...window } });
    }
  }
  for (const window of previous.filter((item) => !active.has(item.windowIdHash))) {
    events.push({ eventType: "WINDOW_CHANGED", payload: { ...window, change: "REMOVED" } });
  }
  return events;
}

function audioChanges(previous: MacosSnapshot["audioDevices"], current: MacosSnapshot["audioDevices"]) {
  const events: Evidence[] = []; const key = (item: MacosSnapshot["audioDevices"][number]) =>
    `${item.deviceIdHash}:${item.direction}`;
  const prior = new Map(previous.map((item) => [key(item), item]));
  const active = new Set(current.map(key));
  for (const device of current) {
    const before = prior.get(key(device));
    if (!before) events.push({ eventType: "AUDIO_DEVICE_ADDED", payload: { ...device } });
    else if (JSON.stringify(before) !== JSON.stringify(device)) {
      events.push({ eventType: "AUDIO_ROUTE_CHANGED", payload: { ...device } });
    }
  }
  for (const device of previous.filter((item) => !active.has(key(item)))) {
    events.push({ eventType: "AUDIO_ROUTE_CHANGED", payload: { ...device, change: "REMOVED" } });
  }
  return events;
}

function matchKey(match: ReturnType<typeof matchMacosSnapshot>[number]) {
  return JSON.stringify([match.ruleKey, match.processId, match.confirmed,
    [...match.identityEvidence].sort(), [...match.activeUseEvidence].sort()]);
}

function publicApplication(application: MacosSnapshot["applications"][number]) {
  const evidence = { ...application };
  delete evidence.identityKey;
  return evidence;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

type Evidence = { eventType: Parameters<MacosEventChain["create"]>[0];
  payload: Readonly<Record<string, unknown>> };
