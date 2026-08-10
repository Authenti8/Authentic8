import {
  BadRequestException, Body, Controller, GoneException, Headers, Inject,
  NotFoundException, Post, Req,
} from "@nestjs/common";
import type { Request } from "express";
import { hashToken } from "../auth/crypto.js";
import { RateLimiterService } from "../auth/rate-limiter.service.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { InterviewLifecycleService } from "./interview-lifecycle.service.js";

@Controller("candidate/verification")
export class CandidateController {
  private readonly rateLimiter: RateLimiterService;

  constructor(
    @Inject(InterviewLifecycleService) private readonly lifecycle: InterviewLifecycleService,
    @Inject(SupabaseService) supabase: SupabaseService,
  ) {
    this.rateLimiter = new RateLimiterService(supabase);
  }

  @Post()
  async verification(@Body() body: VerificationBody, @Req() request: Request) {
    const token = body?.token ?? "";
    assertToken(token);
    await this.limit(request, "lookup", 20, token);
    const result = await this.lifecycle.verification(token);
    if (!result.valid && ["EXPIRED", "ALREADY_USED"].includes(result.reason ?? "")) {
      throw new GoneException("This verification link has expired or was already used.");
    }
    if (!result.valid) throw new NotFoundException("Verification link not found.");
    return result;
  }

  @Post("consent")
  async consent(
    @Body() body: ConsentBody,
    @Headers("user-agent") userAgent: string | undefined,
    @Req() request: Request,
  ) {
    const token = body?.token ?? "";
    assertToken(token);
    await this.limit(request, "consent", 10, token);
    if (!body || !["ACCEPTED", "DECLINED"].includes(body.decision ?? "")) {
      throw new BadRequestException("Choose whether to accept or decline consent.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.consentVersion ?? "")) {
      throw new BadRequestException("The consent version is invalid.");
    }
    const decision = body.decision!;
    const consentVersion = body.consentVersion!;
    const result = await this.lifecycle.consent(token, decision, consentVersion, {
      ipAddress: request.ip ?? "", userAgent: (userAgent ?? "").slice(0, 500),
    });
    if (result.reason) {
      throw new GoneException("This verification request is no longer available.");
    }
    return result;
  }

  private async limit(request: Request, scope: string, count: number, token: string) {
    const address = request.ip ?? "unknown";
    await this.rateLimiter.consume(`candidate:${scope}:token:${hashToken(token)}`, count);
    await this.rateLimiter.consume(`ip:${address}:candidate:${scope}`, count * 20);
  }
}

type VerificationBody = { token?: string };
type ConsentBody = VerificationBody & { decision?: string; consentVersion?: string };

function assertToken(token: string) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new NotFoundException("Verification link not found.");
  }
}
