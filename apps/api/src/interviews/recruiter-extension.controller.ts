import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Query, Req,
  Sse, UseGuards } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { RateLimiterService } from "../auth/rate-limiter.service.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ActiveOrganizationGuard } from "../auth/active-organization.guard.js";
import { RecruiterExtensionService } from "./recruiter-extension.service.js";

@Controller("recruiter-extension")
export class RecruiterExtensionController {
  constructor(
    @Inject(RecruiterExtensionService) private readonly extension: RecruiterExtensionService,
    @Inject(RateLimiterService) private readonly rateLimiter: RateLimiterService,
  ) {}

  @Post("token")
  @UseGuards(SessionGuard, ActiveOrganizationGuard)
  async issue(@Req() request: AuthenticatedRequest, @Body() body: { organizationId?: unknown }) {
    await this.rateLimiter.consume(`recruiter-extension:token:${request.session!.userId}`, 12,
      15 * 60_000);
    return this.extension.issue(request.session!.userId,
      typeof body.organizationId === "string" ? body.organizationId : "");
  }

  @Post("token/refresh")
  refresh(@Headers("authorization") authorization: string | undefined) {
    return this.extension.refresh(authorization);
  }

  @Get("meetings/:meetCode")
  meeting(@Headers("authorization") authorization: string | undefined,
    @Param("meetCode") meetCode: string) {
    return this.extension.meeting(authorization, meetCode);
  }

  @Get("interviews/:id/logs")
  logs(@Headers("authorization") authorization: string | undefined,
    @Param("id", ParseUUIDPipe) interviewId: string, @Query("after") after?: string) {
    const cursor = after === undefined ? 0 : Number(after);
    return this.extension.logs(authorization, interviewId,
      Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0);
  }

  @Sse("interviews/:id/events")
  events(@Headers("authorization") authorization: string | undefined,
    @Param("id", ParseUUIDPipe) interviewId: string, @Query("after") after?: string) {
    const cursor = after === undefined ? 0 : Number(after);
    return this.extension.events(authorization, interviewId,
      Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0);
  }
}
