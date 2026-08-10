import { Controller, Headers, Inject, Post, UnauthorizedException } from "@nestjs/common";
import { loadConfig } from "../config.js";
import { validBearerToken } from "./bearer.js";
import { MailService } from "./mail.service.js";

@Controller("internal/mail")
export class MailWorkerController {
  private readonly config = loadConfig();

  constructor(@Inject(MailService) private readonly mail: MailService) {}

  @Post("drain")
  async drain(@Headers("authorization") authorization?: string) {
    if (!validBearerToken(authorization, this.config.cronSecret)) {
      throw new UnauthorizedException();
    }
    const processed = await this.mail.drainPending(10);
    return { processed };
  }
}
