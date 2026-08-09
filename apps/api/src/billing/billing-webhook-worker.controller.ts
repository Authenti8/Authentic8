import { Controller, Headers, Inject, Post, UnauthorizedException } from "@nestjs/common";
import { validBearerToken } from "../auth/bearer.js";
import { loadConfig } from "../config.js";
import { BillingWebhookWorker } from "./billing-webhook-worker.service.js";

@Controller("internal/billing/webhooks")
export class BillingWebhookWorkerController {
  private readonly config = loadConfig();

  constructor(@Inject(BillingWebhookWorker) private readonly worker: BillingWebhookWorker) {}

  @Post("drain")
  drain(@Headers("authorization") authorization?: string) {
    if (!validBearerToken(authorization, this.config.cronSecret)) {
      throw new UnauthorizedException();
    }
    return this.worker.drain();
  }
}
