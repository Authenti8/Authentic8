import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { hashToken } from "./crypto.js";
import { DatabaseService } from "../database/database.service.js";

@Injectable()
export class RateLimiterService {
  private cleanupInFlight: Promise<void> | null = null;
  private lastCleanupAt = 0;

  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async consume(key: string, limit = 10, windowMs = 15 * 60 * 1000) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + windowMs);
    const result = await this.db.query<{ request_count: number }>(
      rateLimitQuery,
      [hashToken(key), now, expiresAt],
    );
    this.scheduleCleanup(now);
    if ((result.rows[0]?.request_count ?? 0) > limit) {
      throw new HttpException(
        "Please wait before trying again.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private scheduleCleanup(now: Date) {
    const cleanupIntervalMs = 60_000;
    if (this.cleanupInFlight || now.getTime() - this.lastCleanupAt < cleanupIntervalMs) return;
    this.lastCleanupAt = now.getTime();
    this.cleanupInFlight = this.removeExpired(now)
      .catch(() => undefined)
      .finally(() => { this.cleanupInFlight = null; });
  }

  private async removeExpired(now: Date) {
    await this.db.query(
      `DELETE FROM auth_rate_limits WHERE key_hash IN (
         SELECT key_hash FROM auth_rate_limits
         WHERE expires_at <= $1 ORDER BY expires_at LIMIT 100
       )`,
      [now],
    );
  }
}

const rateLimitQuery = `
  INSERT INTO auth_rate_limits(key_hash, request_count, window_started_at, expires_at)
  VALUES ($1, 1, $2, $3)
  ON CONFLICT (key_hash) DO UPDATE SET
    request_count = CASE
      WHEN auth_rate_limits.expires_at <= EXCLUDED.window_started_at THEN 1
      ELSE auth_rate_limits.request_count + 1
    END,
    window_started_at = CASE
      WHEN auth_rate_limits.expires_at <= EXCLUDED.window_started_at
        THEN EXCLUDED.window_started_at
      ELSE auth_rate_limits.window_started_at
    END,
    expires_at = CASE
      WHEN auth_rate_limits.expires_at <= EXCLUDED.window_started_at
        THEN EXCLUDED.expires_at
      ELSE auth_rate_limits.expires_at
    END
  RETURNING request_count`;
