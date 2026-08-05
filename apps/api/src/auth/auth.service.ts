import {
  BadRequestException, Inject, Injectable,
  ServiceUnavailableException, UnauthorizedException,
} from "@nestjs/common";
import type { SessionResponse } from "@authenti8/contracts";
import { loadConfig } from "../config.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import type { LoginDto, ResetPasswordDto, SignupDto, VerifyEmailDto } from "./auth.dto.js";
import type { SessionToken, UserRow } from "./auth.types.js";
import {
  codeChallenge, hashPassword, hashToken,
  randomToken, verifyPassword,
} from "./crypto.js";
import { MailService } from "./mail.service.js";

type GoogleProfile = { sub: string; email: string; email_verified: boolean; name: string };
const dummyPasswordHash = `scrypt:authenti8-dummy-login-salt:${"0".repeat(128)}`;

@Injectable()
export class AuthService {
  private readonly config = loadConfig();

  constructor(
    @Inject(SupabaseService) private readonly supabase: SupabaseService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  async signup(input: SignupDto): Promise<SignupResult> {
    const email = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    let user = await this.findUser(email);
    if (!user) user = await this.createUser(email, input.fullName);
    if (!user) user = await this.findUser(email);
    if (!user || user.email_verified_at || user.status !== "ACTIVE") {
      return this.genericSignupResponse();
    }
    const token = randomToken();
    await this.supabase.rpc("authenti8_create_signup_token", {
      userId: user.id, tokenHash: hashToken(token), passwordHash,
      fullName: input.fullName.trim(), expiresAt: futureIso(24 * 60 * 60 * 1000),
    });
    const previewUrl = await this.mail.dispatchLink(user.email, "verify", token);
    return { ...this.genericSignupResponse(), previewUrl };
  }

  async verifyEmail(input: VerifyEmailDto, metadata: SessionMetadata) {
    const tokenHash = hashToken(input.token);
    const pending = await this.supabase.rpc<PendingSignupRow | null>(
      "authenti8_get_signup_token", { tokenHash },
    );
    if (!pending) throw invalidVerification();
    if (!await verifyPassword(input.password, pending.pending_password_hash)) {
      throw new BadRequestException("This verification link does not match that signup.");
    }
    const userId = await this.supabase.rpc<string | null>(
      "authenti8_complete_signup", { tokenHash },
    );
    if (!userId) throw invalidVerification();
    return this.createSession(userId, metadata);
  }

  async login(input: LoginDto, metadata: SessionMetadata) {
    const user = await this.findUser(normalizeEmail(input.email));
    const valid = await verifyPassword(input.password, user?.password_hash ?? dummyPasswordHash);
    if (!user || !valid || user.status !== "ACTIVE") {
      throw new UnauthorizedException("Email or password is incorrect.");
    }
    if (!user.email_verified_at) {
      throw new UnauthorizedException("Verify your email before signing in.");
    }
    return this.createSession(user.id, metadata);
  }

  async requestPasswordReset(emailInput: string) {
    const startedAt = Date.now();
    const user = await this.findUser(normalizeEmail(emailInput));
    let previewUrl: string | undefined;
    if (user?.status === "ACTIVE") {
      const token = randomToken();
      const outbox = this.mail.usesDurableOutbox
        ? this.mail.prepareOutbox(user.email, "reset", token)
        : null;
      const created = await this.supabase.rpc<boolean>("authenti8_create_reset_token", {
        userId: user.id, tokenHash: hashToken(token),
        expiresAt: futureIso(60 * 60 * 1000), outbox,
      });
      if (created && !this.mail.usesDurableOutbox) {
        previewUrl = await this.mail.dispatchLink(user.email, "reset", token);
      }
    }
    await waitForGenericResponseWindow(startedAt);
    return { ...this.genericResetResponse(), previewUrl };
  }

  async resetPassword(input: ResetPasswordDto) {
    const changed = await this.supabase.rpc<boolean>("authenti8_reset_password", {
      tokenHash: hashToken(input.token), passwordHash: await hashPassword(input.password),
    });
    if (!changed) throw new BadRequestException("This reset link is invalid or expired.");
    return { message: "Password updated. You can now sign in." };
  }

  async resolveSession(rawToken: string) {
    const tokenHash = hashToken(rawToken);
    const row = await this.supabase.rpc<{ id: string; userId: string } | null>(
      "authenti8_resolve_session", { tokenHash },
    );
    return row ? { ...row, tokenHash } : null;
  }

  async getCurrentSession(userId: string): Promise<SessionResponse> {
    const session = await this.supabase.rpc<SessionResponse | null>(
      "authenti8_current_session", { userId },
    );
    if (!session) throw new UnauthorizedException("Account is unavailable.");
    return session;
  }

  async revokeSession(tokenHash: string) {
    await this.supabase.rpc("authenti8_revoke_session", { tokenHash });
  }

  async beginGoogleLogin(returnPath?: string) {
    this.assertGoogleConfigured();
    const state = randomToken();
    const verifier = randomToken(48);
    await this.supabase.rpc("authenti8_create_oauth_state", {
      stateHash: hashToken(state), verifier, returnPath: returnPath ?? null,
      expiresAt: futureIso(10 * 60 * 1000),
    });
    return { state, url: this.googleAuthorizationUrl(state, verifier) };
  }

  async finishGoogleLogin(
    code: string, state: string, browserState: string | undefined,
    metadata: SessionMetadata,
  ) {
    this.assertGoogleConfigured();
    if (!browserState || hashToken(state) !== hashToken(browserState)) {
      throw new BadRequestException("Google login state does not match this browser.");
    }
    const oauthState = await this.supabase.rpc<OauthStateRow | null>(
      "authenti8_consume_oauth_state", { stateHash: hashToken(state) },
    );
    if (!oauthState) throw new BadRequestException("Google login state is invalid or expired.");
    const accessToken = await this.exchangeGoogleCode(code, oauthState.verifier);
    const profile = await this.fetchGoogleProfile(accessToken);
    if (!profile.email_verified) throw new UnauthorizedException("Google email is not verified.");
    const userId = await this.supabase.rpc<string | null>("authenti8_upsert_google_user", {
      subject: profile.sub, email: profile.email, fullName: profile.name.trim().slice(0, 100),
    });
    if (!userId) throw new UnauthorizedException("Google login could not be completed.");
    return { session: await this.createSession(userId, metadata), returnPath: oauthState.returnPath };
  }

  private async createUser(email: string, fullName: string) {
    return this.supabase.rpc<UserRow | null>("authenti8_create_user", {
      email, fullName: fullName.trim(),
    });
  }

  private async findUser(normalizedEmail: string) {
    return this.supabase.rpc<UserRow | null>("authenti8_find_user", { normalizedEmail });
  }

  private async createSession(userId: string, metadata: SessionMetadata) {
    const token: SessionToken = {
      rawToken: randomToken(), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };
    const created = await this.supabase.rpc<{ created: true } | null>(
      "authenti8_create_session",
      {
        userId, tokenHash: hashToken(token.rawToken), expiresAt: token.expiresAt.toISOString(),
        userAgentHash: safeHash(metadata.userAgent), ipHash: safeHash(metadata.ip),
      },
    );
    if (!created) throw new UnauthorizedException("Account is unavailable.");
    return token;
  }

  private assertGoogleConfigured() {
    if (!this.config.googleClientId || !this.config.googleClientSecret) {
      throw new ServiceUnavailableException("Google login is not configured yet.");
    }
  }

  private googleAuthorizationUrl(state: string, verifier: string) {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.config.googleClientId, redirect_uri: this.config.googleCallbackUrl,
      response_type: "code", scope: "openid email profile", state,
      code_challenge: codeChallenge(verifier), code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return url.toString();
  }

  private async exchangeGoogleCode(code: string, verifier: string) {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, code_verifier: verifier, client_id: this.config.googleClientId,
        client_secret: this.config.googleClientSecret,
        redirect_uri: this.config.googleCallbackUrl, grant_type: "authorization_code",
      }),
    });
    if (!response.ok) throw new UnauthorizedException("Google login could not be completed.");
    const data = (await response.json()) as { access_token?: string };
    if (!data.access_token) throw new UnauthorizedException("Google did not return an access token.");
    return data.access_token;
  }

  private async fetchGoogleProfile(accessToken: string) {
    const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new UnauthorizedException("Google profile could not be loaded.");
    return parseGoogleProfile(await response.json());
  }

  private genericSignupResponse() {
    return { message: "Check your inbox to continue setting up Authenti8." };
  }

  private genericResetResponse() {
    return { message: "If that account exists, a password reset link is on its way." };
  }
}

type SessionMetadata = { ip?: string; userAgent?: string };
type SignupResult = { message: string; previewUrl?: string };
type PendingSignupRow = { pending_password_hash: string };
type OauthStateRow = { verifier: string; returnPath?: string };

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function parseGoogleProfile(value: unknown): GoogleProfile {
  if (!value || typeof value !== "object") throw invalidGoogleProfile();
  const profile = value as Record<string, unknown>;
  if (typeof profile.sub !== "string" || !profile.sub.trim()
    || typeof profile.email !== "string" || !profile.email.includes("@")
    || typeof profile.email_verified !== "boolean") throw invalidGoogleProfile();
  const fallbackName = profile.email.split("@", 1)[0] || "Google user";
  return {
    sub: profile.sub, email: normalizeEmail(profile.email),
    email_verified: profile.email_verified,
    name: typeof profile.name === "string" && profile.name.trim()
      ? profile.name.trim() : fallbackName,
  };
}

export function assertActiveGoogleAccount(status: string) {
  if (status !== "ACTIVE") throw new UnauthorizedException("Google login could not be completed.");
}

function invalidGoogleProfile() {
  return new UnauthorizedException("Google returned an invalid profile.");
}

function invalidVerification() {
  return new BadRequestException("This verification link is invalid or expired.");
}

function safeHash(value?: string) {
  return value ? hashToken(value) : null;
}

function futureIso(milliseconds: number) {
  return new Date(Date.now() + milliseconds).toISOString();
}

async function waitForGenericResponseWindow(startedAt: number) {
  const remainingMs = 100 + Math.floor(Math.random() * 50) - (Date.now() - startedAt);
  if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs));
}
