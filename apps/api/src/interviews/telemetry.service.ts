import { BadRequestException, GoneException, Inject, Injectable } from "@nestjs/common";
import type { TelemetryEnvelope } from "@authenti8/event-schemas";
import { isTelemetryEnvelope } from "@authenti8/validation";
import { RateLimiterService } from "../auth/rate-limiter.service.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { verifyTelemetry } from "./telemetry-crypto.js";

@Injectable()
export class TelemetryService {
  constructor(
    @Inject(SupabaseService) private readonly supabase: SupabaseService,
    @Inject(RateLimiterService) private readonly rateLimiter: RateLimiterService,
  ) {}

  async ingest(value: unknown) {
    if (!isTelemetryEnvelope(value)) throw new BadRequestException("Telemetry event is malformed.");
    assertTimestamp(value);
    const context = await this.supabase.rpc<AgentContext>("authenti8_agent_context", {
      verificationSessionId: value.verificationSessionId,
    });
    if (!context.authorized || !context.publicKey) {
      throw new GoneException("Agent session is unavailable.");
    }
    assertDeviceBinding(value, context);
    const eventChainHash = verifyTelemetry(value, context.publicKey);
    if (!eventChainHash) throw new BadRequestException("Telemetry signature is invalid.");
    await this.rateLimiter.consume(
      `agent:telemetry:session:${value.verificationSessionId}`, 1_500, 5 * 60_000,
    );
    const result = await this.supabase.rpc<IngestionResult>("authenti8_ingest_agent_event", {
      ...value, eventChainHash,
    });
    if (!result.accepted) throw new BadRequestException(`Telemetry rejected: ${result.reason}.`);
    return result;
  }

}

function assertDeviceBinding(event: TelemetryEnvelope, context: AgentContext) {
  if (event.platform !== context.platform || event.agentVersion !== context.agentVersion) {
    throw new BadRequestException("Telemetry does not match the enrolled device.");
  }
}

function assertTimestamp(event: TelemetryEnvelope) {
  const timestamp = Date.parse(event.eventTimestamp);
  const futureLimit = Date.now() + 5 * 60_000;
  if (!Number.isFinite(timestamp) || timestamp > futureLimit) {
    throw new BadRequestException("Telemetry timestamp is invalid.");
  }
}

type AgentContext = { authorized: boolean; publicKey?: string; platform?: string;
  agentVersion?: string; replayOnly?: boolean };
type IngestionResult = { accepted: boolean; reason?: string; sequenceNumber?: number };
