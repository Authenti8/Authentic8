import { Body, Controller, Get, Inject, Post, Req, ServiceUnavailableException } from "@nestjs/common";
import type { Request } from "express";
import { isTelemetryEnvelope } from "@authenti8/validation";
import { RateLimiterService } from "../auth/rate-limiter.service.js";
import { TelemetryService } from "./telemetry.service.js";
import { SupabaseService } from "../supabase/supabase.service.js";

@Controller("agent/telemetry")
export class TelemetryController {
  constructor(
    @Inject(TelemetryService) private readonly telemetry: TelemetryService,
    @Inject(RateLimiterService) private readonly rateLimiter: RateLimiterService,
  ) {}

  @Post()
  async ingest(@Body() body: unknown, @Req() request: Request) {
    if (isTelemetryEnvelope(body)) {
      await this.rateLimiter.consume(
        `ip:${request.ip ?? "unknown"}:agent:telemetry`, 30_000, 5 * 60_000,
      );
    }
    return this.telemetry.ingest(body);
  }
}

@Controller("agent")
export class AgentReleaseController {
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  @Get("rules/windows")
  rules() { return this.rulePack("WINDOWS", "WINDOWS_RULE_PACK_JSON"); }

  @Get("rules/macos")
  macosRules() { return this.rulePack("MACOS", "MACOS_RULE_PACK_JSON"); }

  @Get("rules/chrome")
  chromeRules() { return this.rulePack("CHROME", "CHROME_RULE_PACK_JSON"); }

  @Get("releases/windows")
  release() { return releaseJson("WINDOWS_RELEASE_MANIFEST_JSON"); }

  @Get("releases/macos")
  macosRelease() { return releaseJson("MACOS_RELEASE_MANIFEST_JSON"); }

  private async rulePack(platform: string, fallback: string) {
    const pack = await this.supabase.rpc<{ available: boolean; fallbackAllowed?: boolean }
      & Record<string, unknown>>(
      "authenti8_active_rule_pack", { platform });
    if (pack.available) {
      const { available, ...published } = pack;
      void available;
      return published;
    }
    if (pack.fallbackAllowed) return releaseJson(fallback);
    throw new ServiceUnavailableException("The managed detection rule pack is unavailable.");
  }
}

function releaseJson(name: string) {
  const value = process.env[name];
  if (!value) throw new ServiceUnavailableException("Signed agent release metadata is unavailable.");
  try { return JSON.parse(value) as unknown; }
  catch { throw new ServiceUnavailableException("Signed agent release metadata is invalid."); }
}
