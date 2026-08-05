import { timingSafeEqual } from "node:crypto";
import { Controller, Headers, Inject, Post, UnauthorizedException } from "@nestjs/common";
import { loadConfig } from "../config.js";
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
    const processed = await this.mail.drainPending(1);
    return { processed };
  }
}

function validBearerToken(authorization: string | undefined, secret: string) {
  const supplied = Buffer.from(authorization ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
