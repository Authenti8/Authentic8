import { Controller, Headers, Inject, Param, ParseUUIDPipe, Post, Req,
  UnauthorizedException, UseGuards } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { validBearerToken } from "../auth/bearer.js";
import { SessionGuard } from "../auth/session.guard.js";
import { loadConfig } from "../config.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { InterviewLifecycleService } from "./interview-lifecycle.service.js";

@Controller("meetings")
@UseGuards(SessionGuard)
export class MonitoringController {
  constructor(@Inject(InterviewLifecycleService) private readonly lifecycle: InterviewLifecycleService) {}

  @Post(":id/end-monitoring")
  end(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) interviewId: string) {
    return this.lifecycle.endRecruiterMonitoring(request.session!.userId, interviewId);
  }
}

@Controller("internal/reports")
export class ReportWorkerController {
  private readonly config = loadConfig();
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  @Post("drain")
  drain(@Headers("authorization") authorization?: string) {
    if (!validBearerToken(authorization, this.config.cronSecret)) {
      throw new UnauthorizedException();
    }
    return this.supabase.rpc("authenti8_process_reports");
  }
}
