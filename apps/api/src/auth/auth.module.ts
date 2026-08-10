import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { MailService } from "./mail.service.js";
import { MailWorkerController } from "./mail-worker.controller.js";
import { RateLimiterService } from "./rate-limiter.service.js";
import { SessionGuard } from "./session.guard.js";

@Module({
  controllers: [AuthController, MailWorkerController],
  providers: [AuthService, MailService, RateLimiterService, SessionGuard],
  exports: [AuthService, MailService, SessionGuard],
})
export class AuthModule {}
