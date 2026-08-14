import { Controller, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { SessionGuard } from "../auth/session.guard.js";
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
