import { Body, Controller, Get, Inject, Post, Req, ServiceUnavailableException } from "@nestjs/common";
import type { Request } from "express";
import { isTelemetryEnvelope } from "@authenti8/validation";
import { RateLimiterService } from "../auth/rate-limiter.service.js";
import { TelemetryService } from "./telemetry.service.js";

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
  @Get("rules/windows")
  rules() { return releaseJson("WINDOWS_RULE_PACK_JSON"); }

  @Get("releases/windows")
  release() { return releaseJson("WINDOWS_RELEASE_MANIFEST_JSON"); }
}

function releaseJson(name: string) {
  const value = process.env[name];
  if (!value) throw new ServiceUnavailableException("Signed agent release metadata is unavailable.");
  try { return JSON.parse(value) as unknown; }
  catch { throw new ServiceUnavailableException("Signed agent release metadata is invalid."); }
}
