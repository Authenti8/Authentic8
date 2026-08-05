import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { SupabaseService } from "../supabase/supabase.service.js";
import { hashToken } from "./crypto.js";

@Injectable()
export class RateLimiterService {
  private cleanupInFlight?: Promise<unknown>;
  private lastCleanupAt = 0;

  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  async consume(key: string, limit = 10, windowMs = 15 * 60 * 1000) {
    const requestCount = await this.supabase.rpc<number>("authenti8_consume_rate_limit", {
      keyHash: hashToken(key), windowMs,
    });
    this.scheduleCleanup();
    if (requestCount > limit) {
      throw new HttpException("Please wait before trying again.", HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private scheduleCleanup() {
    const now = Date.now();
    if (this.cleanupInFlight || now - this.lastCleanupAt < 60_000) return;
    this.lastCleanupAt = now;
    this.cleanupInFlight = this.supabase.rpc("authenti8_cleanup_rate_limits")
      .catch(() => undefined)
      .finally(() => { this.cleanupInFlight = undefined; });
  }
}
