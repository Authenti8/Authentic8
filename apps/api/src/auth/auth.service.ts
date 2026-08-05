import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { SessionResponse } from "@authenti8/contracts";
import type { PoolClient } from "pg";
import { loadConfig } from "../config.js";
import { DatabaseService } from "../database/database.service.js";
import type { LoginDto, ResetPasswordDto, SignupDto, VerifyEmailDto } from "./auth.dto.js";
import type { SessionToken, UserRow } from "./auth.types.js";
import {
  codeChallenge,
  hashPassword,
  hashToken,
  randomToken,
  verifyPassword,
} from "./crypto.js";
import { MailService } from "./mail.service.js";

type GoogleProfile = { sub: string; email: string; email_verified: boolean; name: string };
const dummyPasswordHash = `scrypt:authenti8-dummy-login-salt:${"0".repeat(128)}`;

@Injectable()
export class AuthService {
  private readonly config = loadConfig();

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
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
    const token = await this.createSignupToken(user.id, input.fullName, passwordHash);
    const previewUrl = await this.mail.dispatchLink(user.email, "verify", token);
    return { ...this.genericSignupResponse(), previewUrl };
  }

  async verifyEmail(
    input: VerifyEmailDto,
    metadata: { ip?: string; userAgent?: string },
  ) {
    const userId = await this.db.transaction(async (client) => {
      const consumed = await client.query<PendingSignupRow>(
        `UPDATE email_verification_tokens SET consumed_at = now()
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
         RETURNING user_id, pending_password_hash, pending_full_name`,
        [hashToken(input.token)],
      );
      const pending = consumed.rows[0];
      if (!pending) {
        throw new BadRequestException("This verification link is invalid or expired.");
      }
      const passwordMatches = await verifyPassword(input.password, pending.pending_password_hash);
      if (!passwordMatches) {
        throw new BadRequestException("This verification link does not match that signup.");
      }
      const verified = await client.query<{ id: string }>(
        `UPDATE users SET password_hash = $1, full_name = $2,
           email_verified_at = now(), updated_at = now()
         WHERE id = $3 AND email_verified_at IS NULL AND status = 'ACTIVE'
         RETURNING id`,
        [pending.pending_password_hash, pending.pending_full_name, pending.user_id],
      );
      const verifiedUserId = verified.rows[0]?.id;
      if (!verifiedUserId) throw new BadRequestException("Account is already verified.");
      await client.query(
        `UPDATE email_verification_tokens SET consumed_at = now()
         WHERE user_id = $1 AND consumed_at IS NULL`,
        [verifiedUserId],
      );
      return verifiedUserId;
    });
    return this.createSession(userId, metadata);
  }

  async login(input: LoginDto, metadata: { ip?: string; userAgent?: string }) {
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
      const token = await this.createPasswordResetToken(user.id, user.email);
      if (token && !this.mail.usesDurableOutbox) {
        previewUrl = await this.mail.dispatchLink(user.email, "reset", token);
      }
    }
    await waitForGenericResponseWindow(startedAt);
    return { ...this.genericResetResponse(), previewUrl };
  }

  async resetPassword(input: ResetPasswordDto) {
    const passwordHash = await hashPassword(input.password);
    const resetUserId = await this.db.transaction(async (client) => {
      const consumed = await client.query<{ user_id: string }>(
        `UPDATE password_reset_tokens SET consumed_at = now()
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
         RETURNING user_id`,
        [hashToken(input.token)],
      );
      const userId = consumed.rows[0]?.user_id;
      if (!userId) return null;
      await client.query(
        `UPDATE password_reset_tokens SET consumed_at = now()
         WHERE user_id = $1 AND consumed_at IS NULL`,
        [userId],
      );
      const eligible = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE",
        [userId],
      );
      if (!eligible.rows[0]) return null;
      await client.query(
        "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2",
        [passwordHash, userId],
      );
      await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1", [userId]);
      return userId;
    });
    if (!resetUserId) throw new BadRequestException("This reset link is invalid or expired.");
    return { message: "Password updated. You can now sign in." };
  }

  async resolveSession(rawToken: string) {
    const tokenHash = hashToken(rawToken);
    const result = await this.db.query<{ id: string; user_id: string }>(
      `UPDATE sessions SET last_seen_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
         AND user_id IN (SELECT id FROM users WHERE status = 'ACTIVE')
       RETURNING id, user_id`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? { id: row.id, userId: row.user_id, tokenHash } : null;
  }

  async getCurrentSession(userId: string): Promise<SessionResponse> {
    const result = await this.db.transaction(
      (client) => client.query<SessionResponseRow>(currentSessionQuery, [userId]),
      { userId },
    );
    const row = result.rows[0];
    if (!row) throw new UnauthorizedException("Account is unavailable.");
    return mapSession(row);
  }

  async revokeSession(tokenHash: string) {
    await this.db.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1", [tokenHash]);
  }

  async beginGoogleLogin(returnPath?: string) {
    this.assertGoogleConfigured();
    const state = randomToken();
    const verifier = randomToken(48);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await this.db.query(
      `INSERT INTO oauth_states(state_hash, verifier, return_path, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [hashToken(state), verifier, returnPath ?? null, expiresAt],
    );
    return { state, url: this.googleAuthorizationUrl(state, verifier) };
  }

  async finishGoogleLogin(
    code: string,
    state: string,
    browserState: string | undefined,
    metadata: SessionMetadata,
  ) {
    this.assertGoogleConfigured();
    if (!browserState || hashToken(state) !== hashToken(browserState)) {
      throw new BadRequestException("Google login state does not match this browser.");
    }
    const oauthState = await this.consumeOauthState(state);
    if (!oauthState) throw new BadRequestException("Google login state is invalid or expired.");
    const accessToken = await this.exchangeGoogleCode(code, oauthState.verifier);
    const profile = await this.fetchGoogleProfile(accessToken);
    if (!profile.email_verified) throw new UnauthorizedException("Google email is not verified.");
    const userId = await this.upsertGoogleUser(profile);
    const session = await this.createSession(userId, metadata);
    return { session, returnPath: oauthState.return_path ?? undefined };
  }

  private async createUser(email: string, fullName: string) {
    try {
      const result = await this.db.query<UserRow>(
        `INSERT INTO users(email, normalized_email, full_name)
         VALUES ($1, $1, $2) RETURNING *`,
        [email, fullName.trim()],
      );
      return result.rows[0] ?? null;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  private async findUser(normalizedEmail: string) {
    const result = await this.db.query<UserRow>(
      "SELECT * FROM users WHERE normalized_email = $1 LIMIT 1",
      [normalizedEmail],
    );
    return result.rows[0] ?? null;
  }

  private async createPasswordResetToken(userId: string, recipient: string) {
    const raw = randomToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    return this.db.transaction(async (client) => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      const recent = await client.query(
        `SELECT 1 FROM password_reset_tokens
         WHERE user_id = $1 AND consumed_at IS NULL
           AND created_at > now() - interval '2 minutes' LIMIT 1`,
        [userId],
      );
      if (recent.rowCount) return null;
      await client.query(
        `INSERT INTO password_reset_tokens(user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [userId, hashToken(raw), expiresAt],
      );
      if (this.mail.usesDurableOutbox) {
        await this.mail.dispatchLink(recipient, "reset", raw, client);
      }
      return raw;
    });
  }

  private async createSignupToken(userId: string, fullName: string, passwordHash: string) {
    const emailToken = randomToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await this.db.query(
      `INSERT INTO email_verification_tokens(
         user_id, token_hash, pending_password_hash, pending_full_name, expires_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [userId, hashToken(emailToken), passwordHash, fullName.trim(), expiresAt],
    );
    return emailToken;
  }

  private async createSession(userId: string, metadata: SessionMetadata) {
    const rawToken = randomToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await this.db.query(
      `INSERT INTO sessions(user_id, token_hash, expires_at, user_agent_hash, ip_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, hashToken(rawToken), expiresAt, safeHash(metadata.userAgent), safeHash(metadata.ip)],
    );
    return { rawToken, expiresAt } satisfies SessionToken;
  }

  private assertGoogleConfigured() {
    if (!this.config.googleClientId || !this.config.googleClientSecret) {
      throw new ServiceUnavailableException("Google login is not configured yet.");
    }
  }

  private googleAuthorizationUrl(state: string, verifier: string) {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.config.googleClientId,
      redirect_uri: this.config.googleCallbackUrl,
      response_type: "code",
      scope: "openid email profile",
      state,
      code_challenge: codeChallenge(verifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return url.toString();
  }

  private async consumeOauthState(state: string) {
    const result = await this.db.query<{ verifier: string; return_path: string | null }>(
      `UPDATE oauth_states SET consumed_at = now()
       WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING verifier, return_path`,
      [hashToken(state)],
    );
    return result.rows[0] ?? null;
  }

  private async exchangeGoogleCode(code: string, verifier: string) {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        code_verifier: verifier,
        client_id: this.config.googleClientId,
        client_secret: this.config.googleClientSecret,
        redirect_uri: this.config.googleCallbackUrl,
        grant_type: "authorization_code",
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

  private async upsertGoogleUser(profile: GoogleProfile) {
    return this.db.transaction(async (client) => {
      const existing = await client.query<{ user_id: string; status: string }>(
        `SELECT identity_row.user_id, account.status FROM auth_identities AS identity_row
         JOIN users AS account ON account.id = identity_row.user_id
         WHERE identity_row.provider = 'GOOGLE' AND identity_row.provider_subject = $1`,
        [profile.sub],
      );
      if (existing.rows[0]) {
        assertActiveGoogleAccount(existing.rows[0].status);
        return existing.rows[0].user_id;
      }
      const userId = await this.findOrCreateGoogleUser(client, profile);
      await client.query(
        `INSERT INTO auth_identities(user_id, provider, provider_subject, provider_email)
         VALUES ($1, 'GOOGLE', $2, $3) ON CONFLICT DO NOTHING`,
        [userId, profile.sub, normalizeEmail(profile.email)],
      );
      return userId;
    });
  }

  private async findOrCreateGoogleUser(client: PoolClient, profile: GoogleProfile) {
    const email = normalizeEmail(profile.email);
    const existing = await client.query<{ id: string; status: string }>(
      "SELECT id, status FROM users WHERE normalized_email = $1 FOR UPDATE",
      [email],
    );
    if (existing.rows[0]) {
      assertActiveGoogleAccount(existing.rows[0].status);
      await client.query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1", [existing.rows[0].id]);
      return existing.rows[0].id;
    }
    const created = await client.query<{ id: string }>(
      `INSERT INTO users(email, normalized_email, full_name, email_verified_at)
       VALUES ($1, $1, $2, now()) RETURNING id`,
      [email, profile.name.trim().slice(0, 100)],
    );
    return created.rows[0]!.id;
  }

  private genericSignupResponse() {
    return { message: "Check your inbox to continue setting up Authenti8." };
  }

  private genericResetResponse() {
    return { message: "If that account exists, a password reset link is on its way." };
  }
}

type SessionMetadata = { ip?: string; userAgent?: string };
type SignupResult = {
  message: string;
  previewUrl?: string;
};
type PendingSignupRow = {
  user_id: string;
  pending_password_hash: string;
  pending_full_name: string;
};
type SessionResponseRow = {
  id: string; email: string; full_name: string; email_verified: boolean;
  organization_id: string | null; organization_name: string | null;
  organization_domain: string | null; organization_role: "OWNER" | "ADMIN" | "RECRUITER" | "VIEWER" | null;
};

const currentSessionQuery = `
  SELECT u.id, u.email, u.full_name, (u.email_verified_at IS NOT NULL) email_verified,
    o.id organization_id, o.name organization_name, o.domain organization_domain,
    om.role organization_role
  FROM users u
  LEFT JOIN organization_members om ON om.user_id = u.id
  LEFT JOIN organizations o ON o.id = om.organization_id
  WHERE u.id = $1 AND u.status = 'ACTIVE'
  ORDER BY om.created_at ASC LIMIT 1`;

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function parseGoogleProfile(value: unknown): GoogleProfile {
  if (!value || typeof value !== "object") {
    throw new UnauthorizedException("Google returned an invalid profile.");
  }
  const profile = value as Record<string, unknown>;
  if (
    typeof profile.sub !== "string" || !profile.sub.trim()
    || typeof profile.email !== "string" || !profile.email.includes("@")
    || typeof profile.email_verified !== "boolean"
  ) {
    throw new UnauthorizedException("Google returned an invalid profile.");
  }
  const fallbackName = profile.email.split("@", 1)[0] || "Google user";
  const name = typeof profile.name === "string" && profile.name.trim()
    ? profile.name.trim()
    : fallbackName;
  return {
    sub: profile.sub,
    email: normalizeEmail(profile.email),
    email_verified: profile.email_verified,
    name,
  };
}

export function assertActiveGoogleAccount(status: string) {
  if (status !== "ACTIVE") {
    throw new UnauthorizedException("Google login could not be completed.");
  }
}

function safeHash(value?: string) {
  return value ? hashToken(value) : null;
}

async function waitForGenericResponseWindow(startedAt: number) {
  const targetMs = 100 + Math.floor(Math.random() * 50);
  const remainingMs = targetMs - (Date.now() - startedAt);
  if (remainingMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, remainingMs));
  }
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

function mapSession(row: SessionResponseRow): SessionResponse {
  return {
    user: { id: row.id, email: row.email, fullName: row.full_name, emailVerified: row.email_verified },
    organization: row.organization_id
      ? { id: row.organization_id, name: row.organization_name!, domain: row.organization_domain!, role: row.organization_role! }
      : null,
  };
}
