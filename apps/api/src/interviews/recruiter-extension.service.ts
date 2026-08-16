import { Injectable, UnauthorizedException } from "@nestjs/common";
import { hashToken, randomToken } from "../auth/crypto.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { concatMap, from, ignoreElements, interval, map, merge, Observable,
  switchMap, takeUntil, timer, type Subscriber } from "rxjs";
import { OperationalFailureService } from "../observability/operational-failure.service.js";

@Injectable()
export class RecruiterExtensionService {
  private readonly feeds = new Map<string, LiveFeed>();

  constructor(private readonly supabase: SupabaseService,
    private readonly failures?: OperationalFailureService) {}

  async issue(userId: string, organizationId: string) {
    assertUuid(organizationId);
    const token = randomToken();
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const authorizationExpiresAt = new Date(Date.now() + 8 * 60 * 60_000).toISOString();
    const result = await this.supabase.rpc<{ issued: boolean }>("authenti8_issue_recruiter_token",
      { userId, organizationId, tokenHash: hashToken(token), expiresAt, authorizationExpiresAt });
    if (!result.issued) throw new UnauthorizedException("Workspace membership is required.");
    return { token, expiresAt };
  }

  async refresh(authorization: string | undefined) {
    const current = bearer(authorization); const token = randomToken();
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const result = await this.supabase.rpc<{ rotated: boolean; expiresAt?: string }>(
      "authenti8_rotate_recruiter_token", { tokenHash: hashToken(current),
        replacementHash: hashToken(token), expiresAt });
    if (!result.rotated || !result.expiresAt) {
      throw new UnauthorizedException("Extension token expired.");
    }
    return { token, expiresAt: result.expiresAt };
  }

  async meeting(authorization: string | undefined, meetCode: string) {
    const identity = await this.identity(authorization);
    return this.supabase.rpc<MeetingResult>("authenti8_recruiter_meeting",
      { userId: identity.userId, organizationId: identity.organizationId,
        meetCode: normalizeMeetCode(meetCode) });
  }

  async logs(authorization: string | undefined, interviewId: string, after: number) {
    const identity = await this.identity(authorization);
    const result = await this.supabase.rpc<LogsResult>("authenti8_recruiter_logs",
      { userId: identity.userId, organizationId: identity.organizationId, interviewId, after });
    if (!result.authorized) throw new UnauthorizedException("Interview access is unavailable.");
    return result;
  }

  events(authorization: string | undefined, interviewId: string, after: number) {
    return from(this.identity(authorization)).pipe(switchMap((identity) => {
      const feed = this.feed(identity, interviewId, after);
      const revalidate = interval(30_000).pipe(concatMap(() => this.identity(authorization)),
        ignoreElements());
      const expiresIn = Math.max(0, Date.parse(identity.expiresAt!) - Date.now());
      return merge(feed, revalidate).pipe(takeUntil(timer(expiresIn)), map((event) => ({ data: event })));
    }));
  }

  private feed(identity: TokenIdentity, interviewId: string, after: number) {
    const key = `${identity.userId}:${identity.organizationId}:${interviewId}`;
    return new Observable<StreamEvent>((subscriber) => {
      const feed = this.feeds.get(key) ?? this.createFeed(identity, interviewId);
      feed.subscribers.set(subscriber, after);
      if (!feed.timer && !feed.polling) this.scheduleFeed(key, feed, 0);
      return () => {
        feed.subscribers.delete(subscriber);
        if (feed.subscribers.size === 0) {
          if (feed.timer) clearTimeout(feed.timer);
          if (this.feeds.get(key) === feed) this.feeds.delete(key);
        }
      };
    });
  }

  private createFeed(identity: TokenIdentity, interviewId: string): LiveFeed {
    return { identity, interviewId, subscribers: new Map(), polling: false };
  }

  private scheduleFeed(key: string, feed: LiveFeed, delay: number) {
    feed.timer = setTimeout(() => { feed.timer = undefined; void this.pollFeed(key, feed); }, delay);
    this.feeds.set(key, feed);
  }

  private async pollFeed(key: string, feed: LiveFeed) {
    if (feed.polling || feed.subscribers.size === 0) return;
    feed.polling = true;
    try {
      const participants = new Map(feed.subscribers);
      const cursor = Math.min(...participants.values());
      const result = await this.authorizedLogs(feed.identity, feed.interviewId, cursor);
      if (result.events.length === 0) {
        for (const subscriber of participants.keys()) {
          if (feed.subscribers.has(subscriber)) subscriber.next({ heartbeat: true });
        }
      } else {
        for (const event of result.events) this.publishFeedEvent(feed, participants, event);
      }
      if (feed.subscribers.size > 0) {
        this.scheduleFeed(key, feed, result.events.length === 500 ? 0 : 2_000);
      }
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) {
        await this.failures?.record({ component: "LIVE_STREAM", errorCode: "LIVE_LOG_POLL_FAILED",
          safeMessage: "Recruiter live-log polling failed.", reference: feed.interviewId,
          organizationId: feed.identity.organizationId, interviewId: feed.interviewId });
      }
      for (const subscriber of feed.subscribers.keys()) subscriber.error(error);
      if (this.feeds.get(key) === feed) this.feeds.delete(key);
    } finally { feed.polling = false; }
  }

  private publishFeedEvent(feed: LiveFeed, participants: ReadonlyMap<Subscriber<StreamEvent>, number>,
    event: StreamEvent) {
    const sequence = Number(event.sequence);
    if (!Number.isSafeInteger(sequence)) return;
    for (const [subscriber] of participants) {
      const cursor = feed.subscribers.get(subscriber);
      if (cursor === undefined) continue;
      if (sequence <= cursor) continue;
      feed.subscribers.set(subscriber, sequence);
      subscriber.next(event);
    }
  }

  private async authorizedLogs(identity: TokenIdentity, interviewId: string, after: number) {
    const result = await this.supabase.rpc<LogsResult>("authenti8_recruiter_logs",
      { userId: identity.userId!, organizationId: identity.organizationId!, interviewId, after });
    if (!result.authorized) throw new UnauthorizedException("Interview access is unavailable.");
    return result;
  }

  private async identity(authorization: string | undefined) {
    const token = bearer(authorization);
    const result = await this.supabase.rpc<TokenIdentity>("authenti8_resolve_recruiter_token",
      { tokenHash: hashToken(token) });
    if (!result.valid || !result.userId || !result.organizationId || !result.expiresAt
      || !Number.isFinite(Date.parse(result.expiresAt))) {
      throw new UnauthorizedException("Extension token expired.");
    }
    return result;
  }
}

function assertUuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value)) throw new UnauthorizedException("Workspace selection is invalid.");
}

function bearer(value: string | undefined) {
  const match = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(value ?? "");
  if (!match) throw new UnauthorizedException("Extension authentication is required.");
  return match[1]!;
}

function normalizeMeetCode(value: string) {
  const code = value.trim().toLowerCase();
  if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code)) {
    throw new UnauthorizedException("Google Meet code is invalid.");
  }
  return code;
}

type TokenIdentity = { valid: boolean; userId?: string; organizationId?: string; expiresAt?: string };
type MeetingResult = { protected: boolean; interviewId?: string; candidateName?: string;
  status?: string; platform?: string; coveragePercentage?: number; detectionResult?: string };
type LogsResult = { authorized: boolean; events: readonly StreamEvent[] };
type StreamEvent = Record<string, unknown> & { sequence?: number };
type LiveFeed = { identity: TokenIdentity; interviewId: string;
  subscribers: Map<Subscriber<StreamEvent>, number>; polling: boolean;
  timer?: ReturnType<typeof setTimeout> };
