import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { MailService } from "./mail.service.js";
import { RateLimiterService } from "./rate-limiter.service.js";
import { SessionGuard } from "./session.guard.js";

@Module({
  controllers: [AuthController],
  providers: [AuthService, MailService, RateLimiterService, SessionGuard],
  exports: [AuthService, SessionGuard],
})
export class AuthModule {}
