import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { loadConfig } from "../config.js";
import { EmailDto, LoginDto, ResetPasswordDto, SignupDto, VerifyEmailDto } from "./auth.dto.js";
import { AuthService } from "./auth.service.js";
import type { AuthenticatedRequest } from "./auth.types.js";
import {
  clearOauthStateCookie,
  clearSessionCookie,
  OAUTH_STATE_COOKIE,
  readCookie,
  setOauthStateCookie,
  setSessionCookie,
} from "./cookies.js";
import { RateLimiterService } from "./rate-limiter.service.js";
import { SessionGuard } from "./session.guard.js";

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(RateLimiterService) private readonly rateLimiter: RateLimiterService,
  ) {}

  @Post("signup")
  async signup(
    @Body() input: SignupDto,
    @Req() request: Request,
  ) {
    await this.limit(request, "signup", 5);
    return this.auth.signup(input);
  }

  @Post("verify-email")
  async verifyEmail(
    @Body() input: VerifyEmailDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.limit(request, "verify", 10);
    const session = await this.auth.verifyEmail(input, metadata(request));
    setSessionCookie(response, session);
    return { message: "Email verified.", next: "/onboarding" };
  }

  @Post("login")
  async login(
    @Body() input: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.limit(request, "login", 10);
    const session = await this.auth.login(input, metadata(request));
    setSessionCookie(response, session);
    return { message: "Welcome back.", next: "/dashboard" };
  }

  @Post("forgot-password")
  async forgotPassword(@Body() input: EmailDto, @Req() request: Request) {
    await this.limit(request, "forgot", 5);
    return this.auth.requestPasswordReset(input.email);
  }

  @Post("reset-password")
  async resetPassword(@Body() input: ResetPasswordDto, @Req() request: Request) {
    await this.limit(request, "reset", 8);
    return this.auth.resetPassword(input);
  }

  @Get("google")
  async google(
    @Query("next") next: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    await this.limit(request, "google", 10);
    const flow = await this.auth.beginGoogleLogin(safeAuthReturnPath(next));
    setOauthStateCookie(response, flow.state);
    response.redirect(flow.url);
  }

  @Get("google/callback")
  async googleCallback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") error: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const origin = loadConfig().appOrigin;
    const browserState = readCookie(request.headers.cookie, OAUTH_STATE_COOKIE);
    clearOauthStateCookie(response);
    if (error || !code || !state) return response.redirect(`${origin}/login?error=google_cancelled`);
    try {
      const completed = await this.auth.finishGoogleLogin(
        code,
        state,
        browserState,
        metadata(request),
      );
      setSessionCookie(response, completed.session);
      return response.redirect(`${origin}${completed.returnPath ?? "/auth/complete"}`);
    } catch {
      return response.redirect(`${origin}/login?error=google_failed`);
    }
  }

  @Get("session")
  @UseGuards(SessionGuard)
  session(@Req() request: AuthenticatedRequest) {
    return this.auth.getCurrentSession(request.session!.userId);
  }

  @Post("logout")
  @UseGuards(SessionGuard)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.revokeSession(request.session!.tokenHash);
    clearSessionCookie(response);
    return { message: "Signed out." };
  }

  private async limit(request: Request, scope: string, count: number) {
    const address = request.ip ?? "unknown";
    await this.rateLimiter.consume(`ip:${address}:${scope}`, count * 4);
  }
}

function metadata(request: Request) {
  return { ip: request.ip, userAgent: request.headers["user-agent"] };
}

export function safeAuthReturnPath(path: string | undefined) {
  if (!path) return undefined;
  const allowed = ["/dashboard", "/onboarding"];
  return allowed.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    ? path
    : undefined;
}
