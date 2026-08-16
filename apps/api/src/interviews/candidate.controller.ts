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

  @Post("end")
  async end(@Body() body: VerificationBody, @Req() request: Request) {
    const token = body?.token ?? "";
    assertToken(token);
    await this.limit(request, "end", 10, token);
    const result = await this.lifecycle.endCandidateMonitoring(token) as StopResult;
    if (!result.stopped) throw new GoneException("Monitoring is no longer active.");
    return result;
  }

  @Post("disputes")
  async dispute(@Body() body: DisputeBody, @Req() request: Request) {
    const token = body?.token ?? "";
    assertToken(token);
    await this.limit(request, "dispute", 3, token);
    const reason = body?.reason?.trim() ?? "";
    if (reason.length < 20 || reason.length > 2000) {
      throw new BadRequestException("Explain the dispute in 20 to 2000 characters.");
    }
    const result = await this.lifecycle.submitCandidateDispute(token, reason) as DisputeResult;
    if (!result.submitted && result.reason === "TOKEN_UNAVAILABLE") {
      throw new GoneException("This interview is no longer available for dispute.");
    }
    if (!result.submitted) throw new BadRequestException("The dispute could not be submitted.");
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
type StopResult = { stopped?: boolean };
type DisputeBody = VerificationBody & { reason?: string };
type DisputeResult = { submitted?: boolean; reason?: string };

function assertToken(token: string) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new NotFoundException("Verification link not found.");
  }
}
