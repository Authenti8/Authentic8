import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { MailService } from "./mail.service.js";
import { MailWorkerController } from "./mail-worker.controller.js";
import { RateLimiterService } from "./rate-limiter.service.js";
import { SessionGuard } from "./session.guard.js";
import { ActiveOrganizationGuard } from "./active-organization.guard.js";

@Module({
  controllers: [AuthController, MailWorkerController],
  providers: [AuthService, MailService, RateLimiterService, SessionGuard, ActiveOrganizationGuard],
  exports: [AuthService, MailService, RateLimiterService, SessionGuard, ActiveOrganizationGuard],
})
export class AuthModule {}
