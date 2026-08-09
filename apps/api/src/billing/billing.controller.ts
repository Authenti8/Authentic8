import {
  Body, Controller, Get, Headers, HttpCode, Inject, Post, RawBodyRequest, Req,
  UnauthorizedException, UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { SessionGuard } from "../auth/session.guard.js";
import { loadConfig } from "../config.js";
import { BillingService, type DodoEvent } from "./billing.service.js";
import { CreateCheckoutDto } from "./billing.dto.js";
import { dodoWebhookId, verifyDodoWebhook } from "./dodo-webhook.js";
import { BillingWebhookWorker } from "./billing-webhook-worker.service.js";

@Controller("billing")
export class BillingController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(BillingWebhookWorker) private readonly webhooks: BillingWebhookWorker,
  ) {}

  @Get()
  @UseGuards(SessionGuard)
  summary(@Req() request: AuthenticatedRequest) {
    return this.billing.summary(request.session!.userId);
  }

  @Post("checkout")
  @UseGuards(SessionGuard)
  checkout(@Req() request: AuthenticatedRequest, @Body() input: CreateCheckoutDto) {
    return this.billing.createCheckout(request.session!.userId, input);
  }

  @Post("portal")
  @UseGuards(SessionGuard)
  portal(@Req() request: AuthenticatedRequest) {
    return this.billing.createPortal(request.session!.userId);
  }

  @Post("webhooks/dodo")
  @HttpCode(200)
  webhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    const secret = loadConfig().dodo.webhookKey;
    if (!request.rawBody || !verifyDodoWebhook(request.rawBody, headers, secret)) {
      throw new UnauthorizedException("Invalid Dodo webhook signature.");
    }
    const body = request.body as DodoEvent;
    const eventId = dodoWebhookId(headers);
    if (!eventId) throw new UnauthorizedException("Missing Dodo webhook identifier.");
    return this.webhooks.enqueue({ ...body, id: eventId });
  }
}
