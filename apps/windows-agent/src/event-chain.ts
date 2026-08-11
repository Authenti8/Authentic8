import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { telemetryChainMaterial, telemetrySignatureMessage } from "@authenti8/security";
import { telemetrySchemaVersion, type TelemetryEnvelope, type TelemetryEventType } from "@authenti8/event-schemas";

export class EventChain {
  private sequence = 0;
  private previousHash: string | undefined;
  private readonly started = process.hrtime.bigint();

  constructor(private readonly context: ChainContext, state?: ChainState) {
    this.sequence = state?.sequence ?? 0;
    this.previousHash = state?.previousHash;
  }

  create(eventType: TelemetryEventType, payload: Readonly<Record<string, unknown>>) {
    const payloadHash = hash(canonicalJson(payload));
    const unsigned = { verificationSessionId: this.context.sessionId, eventId: randomUUID(),
      sequenceNumber: this.sequence, eventType, eventTimestamp: new Date().toISOString(),
      monotonicTimestamp: Number((process.hrtime.bigint() - this.started) / 1_000_000n),
      platform: "WINDOWS" as const, agentVersion: this.context.agentVersion,
      rulePackVersion: this.context.rulePackVersion, payloadHash,
      ...(this.previousHash ? { previousEventHash: this.previousHash } : {}) };
    const message = telemetrySignatureMessage(unsigned);
    const signature = sign(null, Buffer.from(message), createPrivateKey(this.context.privateKey))
      .toString("base64url");
    const event: TelemetryEnvelope = { schemaVersion: telemetrySchemaVersion,
      ...unsigned, payload, signature };
    this.previousHash = hash(telemetryChainMaterial(message, signature));
    this.sequence += 1;
    return event;
  }

  state(): ChainState {
    return { sequence: this.sequence,
      ...(this.previousHash ? { previousHash: this.previousHash } : {}) };
  }

  setRulePackVersion(version: string) {
    this.context.rulePackVersion = version;
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

type ChainContext = { sessionId: string; privateKey: string; agentVersion: string; rulePackVersion: string };
export type ChainState = { sequence: number; previousHash?: string };
