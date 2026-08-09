import {
  Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Req,
  UnauthorizedException, UseGuards,
} from "@nestjs/common";
import type { DashboardOverview, InterviewSummary } from "@authenti8/contracts";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { validBearerToken } from "../auth/bearer.js";
import { SessionGuard } from "../auth/session.guard.js";
import { loadConfig } from "../config.js";
import { SupabaseService } from "../supabase/supabase.service.js";

@Controller()
@UseGuards(SessionGuard)
export class WorkspaceController {
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  @Get("overview")
  overview(@Req() request: AuthenticatedRequest) {
    return this.supabase.rpc<DashboardOverview>("authenti8_dashboard_overview", {
      userId: request.session!.userId,
    });
  }

  @Get("meetings")
  meetings(@Req() request: AuthenticatedRequest) {
    return this.supabase.rpc<InterviewSummary[]>("authenti8_list_interviews", {
      userId: request.session!.userId,
    });
  }

}

@Controller("internal/workspace")
export class WorkspaceMaintenanceController {
  private readonly config = loadConfig();
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  @Post("meetings/:id/reserve")
  reserve(@Headers("authorization") authorization: string | undefined,
    @Param("id", ParseUUIDPipe) id: string) {
    this.authorize(authorization);
    return this.supabase.rpc("authenti8_reserve_credit", { interviewId: id });
  }

  @Post("meetings/:id/consume")
  consume(@Headers("authorization") authorization: string | undefined,
    @Param("id", ParseUUIDPipe) id: string) {
    this.authorize(authorization);
    return this.supabase.rpc("authenti8_consume_credit", { interviewId: id });
  }

  @Post("meetings/:id/release")
  release(@Headers("authorization") authorization: string | undefined,
    @Param("id", ParseUUIDPipe) id: string) {
    this.authorize(authorization);
    return this.supabase.rpc("authenti8_release_credit", { interviewId: id });
  }

  private authorize(authorization: string | undefined) {
    if (!validBearerToken(authorization, this.config.cronSecret)) {
      throw new UnauthorizedException();
    }
  }
}
