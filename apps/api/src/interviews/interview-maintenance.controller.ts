import { Controller, Headers, Inject, Post, UnauthorizedException } from "@nestjs/common";
import { validBearerToken } from "../auth/bearer.js";
import { loadConfig } from "../config.js";
import { InterviewLifecycleService } from "./interview-lifecycle.service.js";

@Controller("internal/interviews")
export class InterviewMaintenanceController {
  private readonly config = loadConfig();

  constructor(@Inject(InterviewLifecycleService) private readonly lifecycle: InterviewLifecycleService) {}

  @Post("orchestrate")
  orchestrate(@Headers("authorization") authorization?: string) {
    if (!validBearerToken(authorization, this.config.cronSecret)) {
      throw new UnauthorizedException();
    }
    return this.lifecycle.drain();
  }
}
