import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Inject, Post, Query,
  Req, UnauthorizedException, UseGuards,
} from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { validBearerToken } from "../auth/bearer.js";
import { accuracyArtifact, attestedAccuracyInput, validAccuracySignature } from
  "./accuracy-attestation.js";
import { SessionGuard } from "../auth/session.guard.js";
import { loadConfig } from "../config.js";
import { SupabaseService } from "../supabase/supabase.service.js";

@Controller("admin")
@UseGuards(SessionGuard)
export class AdminController {
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  @Get("overview")
  async overview(@Req() request: AuthenticatedRequest, @Query("query") query?: string) {
    if (query && query.length > 120) throw new BadRequestException("Search query is too long.");
    const result = await this.supabase.rpc("authenti8_admin_overview", {
      userId: request.session!.userId, query: query?.trim() || undefined,
    });
    if (!result) throw new ForbiddenException("Platform administrator access is required.");
    return result;
  }

  @Post("changes")
  async requestChange(@Req() request: AuthenticatedRequest,
    @Body() body: Record<string, unknown>) {
    const result = await this.supabase.rpc<{ created: boolean; reason?: string }>(
      "authenti8_request_admin_change", { ...body, userId: request.session!.userId },
    );
    if (!result.created) throw new BadRequestException(result.reason ?? "Change was rejected.");
    return result;
  }

  @Post("changes/approve")
  async approveChange(@Req() request: AuthenticatedRequest,
    @Body() body: Record<string, unknown>) {
    const result = await this.supabase.rpc<{ applied: boolean; reason?: string }>(
      "authenti8_approve_admin_change", { ...body, userId: request.session!.userId },
    );
    if (!result.applied) throw new BadRequestException(result.reason ?? "Change was rejected.");
    return result;
  }

  @Post("disputes/resolve")
  async resolveDispute(@Req() request: AuthenticatedRequest,
    @Body() body: Record<string, unknown>) {
    const result = await this.supabase.rpc<{ updated: boolean; reason?: string }>(
      "authenti8_resolve_candidate_dispute", { ...body, userId: request.session!.userId },
    );
    if (!result.updated) throw new BadRequestException(result.reason ?? "Dispute was not updated.");
    return result;
  }

  @Get("pilot-readiness")
  async pilotReadiness(@Req() request: AuthenticatedRequest) {
    const result = await this.supabase.rpc("authenti8_pilot_readiness", {
      userId: request.session!.userId,
    });
    if (!result) throw new ForbiddenException("Platform administrator access is required.");
    return result;
  }
}

@Controller("internal/operations")
export class OperationsController {
  private readonly config = loadConfig();
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  @Post("retention")
  retention(@Headers("authorization") authorization?: string) {
    this.authorize(authorization);
    return this.supabase.rpc("authenti8_run_retention");
  }

  @Post("recover")
  recover(@Headers("authorization") authorization?: string) {
    this.authorize(authorization);
    return this.supabase.rpc("authenti8_recover_operations");
  }

  @Post("accuracy")
  accuracy(@Headers("authorization") authorization: string | undefined,
    @Headers("x-authenti8-signature") signature: string | undefined,
    @Body() body: Record<string, unknown>) {
    if (!validBearerToken(authorization, this.config.accuracyUploadSecret)) {
      throw new UnauthorizedException();
    }
    const artifact = accuracyArtifact(body);
    if (!validAccuracySignature(artifact.payload, signature, this.config.accuracyUploadSecret)) {
      throw new UnauthorizedException("A valid accuracy artifact signature is required.");
    }
    return this.supabase.rpc("authenti8_record_accuracy_run", attestedAccuracyInput(body));
  }

  @Post("accuracy-release")
  accuracyRelease(@Headers("authorization") authorization: string | undefined,
    @Headers("x-authenti8-signature") signature: string | undefined,
    @Body() body: Record<string, unknown>) {
    if (!validBearerToken(authorization, this.config.accuracyUploadSecret)) {
      throw new UnauthorizedException();
    }
    const artifact = accuracyArtifact(body);
    if (!validAccuracySignature(artifact.payload, signature, this.config.accuracyUploadSecret)) {
      throw new UnauthorizedException("A valid accuracy release signature is required.");
    }
    const results = Array.isArray(body.results) ? body.results.filter((item) =>
      item !== null && typeof item === "object" && !Array.isArray(item)).map((item) =>
      attestedAccuracyInput(item as Record<string, unknown>)) : [];
    return this.supabase.rpc("authenti8_record_accuracy_release", { results });
  }

  @Post("versions")
  version(@Headers("authorization") authorization: string | undefined,
    @Body() body: Record<string, unknown>) {
    this.authorize(authorization);
    if (requiresAccuracyReleaseGate(body)) {
      throw new ForbiddenException("Production agents require the signed accuracy release gate.");
    }
    return this.supabase.rpc("authenti8_register_application_version", body);
  }

  private authorize(authorization?: string) {
    if (!validBearerToken(authorization, this.config.cronSecret)) {
      throw new UnauthorizedException();
    }
  }
}

export function requiresAccuracyReleaseGate(body: Record<string, unknown>) {
  return body.releaseChannel === "PRODUCTION"
    && ["WINDOWS_AGENT", "MACOS_AGENT"].includes(String(body.application));
}
