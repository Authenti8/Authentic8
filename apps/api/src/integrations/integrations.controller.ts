import {
  Controller, Get, Headers, HttpCode, Inject, Post, Query, Req, Res,
  Logger, UnauthorizedException, UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { clearIntegrationStateCookie, INTEGRATION_STATE_COOKIE, readCookie, setIntegrationStateCookie } from "../auth/cookies.js";
import { validBearerToken } from "../auth/bearer.js";
import { SessionGuard } from "../auth/session.guard.js";
import { loadConfig } from "../config.js";
import { GoogleApiError, GoogleCalendarService } from "./google-calendar.service.js";

@Controller("integrations")
export class IntegrationsController {
  private readonly logger = new Logger(IntegrationsController.name);

  constructor(@Inject(GoogleCalendarService) private readonly google: GoogleCalendarService) {}

  @Get()
  @UseGuards(SessionGuard)
  summary(@Req() request: AuthenticatedRequest) {
    return this.google.summary(request.session!.userId);
  }

  @Get("google/connect")
  @UseGuards(SessionGuard)
  async connect(@Req() request: AuthenticatedRequest, @Res() response: Response) {
    const flow = await this.google.begin(request.session!.userId);
    setIntegrationStateCookie(response, flow.state);
    response.redirect(flow.url);
  }

  @Get("google/callback")
  @UseGuards(SessionGuard)
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") error: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ) {
    const origin = loadConfig().appOrigin;
    const browserState = readCookie(request.headers.cookie as string | undefined, INTEGRATION_STATE_COOKIE);
    clearIntegrationStateCookie(response);
    if (error || !code || !state) return response.redirect(`${origin}/dashboard/integrations?error=cancelled`);
    try {
      const result = await this.google.finish(request.session!.userId, code, state, browserState);
      const outcome = result.realtime ? "connected=google" : "warning=watch";
      return response.redirect(`${origin}/dashboard/integrations?${outcome}`);
    } catch (caught) {
      this.logger.warn(`Google Calendar OAuth callback failed: ${oauthFailure(caught)}`);
      return response.redirect(`${origin}/dashboard/integrations?error=google`);
    }
  }

  @Post("google/sync")
  @UseGuards(SessionGuard)
  sync(@Req() request: AuthenticatedRequest) {
    return this.google.sync(request.session!.userId);
  }

  @Post("google/disconnect")
  @UseGuards(SessionGuard)
  disconnect(@Req() request: AuthenticatedRequest) {
    return this.google.disconnect(request.session!.userId);
  }

  @Post("google/webhook")
  @HttpCode(202)
  webhook(
    @Headers("x-goog-channel-id") channelId?: string,
    @Headers("x-goog-channel-token") channelToken?: string,
  ) {
    return channelId && channelToken
      ? this.google.enqueueChannel(channelId, channelToken) : { ignored: true };
  }
}

function oauthFailure(caught: unknown) {
  if (caught instanceof GoogleApiError) return `Google API ${caught.googleStatus}`;
  if (caught instanceof Error) return caught.name || "Error";
  return "Unknown error";
}

@Controller("internal/integrations")
export class IntegrationMaintenanceController {
  private readonly config = loadConfig();
  constructor(@Inject(GoogleCalendarService) private readonly google: GoogleCalendarService) {}

  @Post("renew")
  renew(@Headers("authorization") authorization?: string) {
    if (!validBearerToken(authorization, this.config.cronSecret)) {
      throw new UnauthorizedException();
    }
    return this.google.renewChannels();
  }

  @Post("sync")
  sync(@Headers("authorization") authorization?: string) {
    if (!validBearerToken(authorization, this.config.cronSecret)) {
      throw new UnauthorizedException();
    }
    return this.google.drainSyncJobs();
  }
}
