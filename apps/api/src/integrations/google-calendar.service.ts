import {
  BadGatewayException, BadRequestException, Inject, Injectable, Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { codeChallenge, hashToken, randomToken } from "../auth/crypto.js";
import { loadConfig } from "../config.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { normalizeGoogleEvent } from "./calendar-events.js";
import type {
  EventPage, GoogleCalendar, GoogleEvent, GoogleProfile, GoogleTokenResponse,
  GoogleWatchResponse, IntegrationCredentials,
} from "./google.types.js";
import { decryptIntegrationToken, encryptIntegrationToken } from "./token-crypto.js";

@Injectable()
export class GoogleCalendarService {
  private readonly config = loadConfig();
  private readonly logger = new Logger(GoogleCalendarService.name);
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  async begin(userId: string) {
    this.assertConfigured();
    const state = randomToken();
    const verifier = randomToken(64);
    const created = await this.supabase.rpc("authenti8_create_integration_state", {
      userId, stateHash: hashToken(state), verifier,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    if (!created) throw new BadRequestException("Only workspace owners and admins can connect integrations.");
    return { state, url: this.authorizationUrl(state, verifier) };
  }

  async finish(userId: string, code: string, state: string, browserState?: string) {
    if (!browserState || state !== browserState) throw new BadRequestException("OAuth state mismatch.");
    const oauth = await this.supabase.rpc<OAuthState>("authenti8_consume_integration_state", {
      userId, stateHash: hashToken(state),
    });
    if (!oauth?.organizationId) throw new BadRequestException("OAuth state expired.");
    const tokens = await this.exchangeCode(code, oauth.verifier);
    const [profile, calendar] = await Promise.all([
      this.googleGet<GoogleProfile>("https://openidconnect.googleapis.com/v1/userinfo", tokens.access_token),
      this.googleGet<GoogleCalendar>(
        "https://www.googleapis.com/calendar/v3/users/me/calendarList/primary", tokens.access_token,
      ),
    ]);
    const previous = await this.supabase.rpc<IntegrationCredentials>(
      "authenti8_integration_credentials", { userId },
    );
    const previousChannel = await this.preparePreviousChannel(previous);
    const integration = await this.storeIntegration(oauth, profile, calendar, tokens);
    const realtime = await this.registerInitialWatch(
      integration.id, integration.generation, calendar.id, tokens.access_token, previousChannel,
    );
    await this.supabase.rpc("authenti8_enqueue_calendar_sync_by_id", {
      integrationId: integration.id,
    });
    return { connected: true, realtime };
  }

  summary(userId: string) {
    return this.supabase.rpc("authenti8_integration_summary", { userId });
  }

  async sync(userId: string) {
    const credentials = await this.supabase.rpc<IntegrationCredentials>(
      "authenti8_integration_credentials", { userId },
    );
    if (!credentials?.id) throw new BadRequestException("Google Calendar is not connected.");
    const result = await this.syncCredentials(credentials);
    await this.supabase.rpc("authenti8_reconcile_user_credits", { userId });
    return result;
  }

  enqueueChannel(channelId: string, channelToken: string) {
    return this.supabase.rpc("authenti8_enqueue_calendar_sync", {
      channelId, channelTokenHash: hashToken(channelToken),
    });
  }

  async disconnect(userId: string) {
    const previous = await this.supabase.rpc<IntegrationCredentials>(
      "authenti8_integration_credentials", { userId },
    );
    await this.stopPreviousChannel(previous);
    return this.supabase.rpc("authenti8_disconnect_google", { userId });
  }

  async renewChannels() {
    const due = await this.supabase.rpc<IntegrationCredentials[]>(
      "authenti8_due_calendar_channels", {},
    );
    const results = await Promise.allSettled((due ?? []).map((item) => this.renewChannel(item)));
    const failed = results.filter((item) => item.status === "rejected");
    const summary = { examined: results.length,
      renewed: results.length - failed.length, failed: failed.length };
    failed.forEach((item) => this.logger.error(
      `Calendar channel renewal failed: ${errorMessage(item.reason)}`,
    ));
    if (failed.length) {
      throw new ServiceUnavailableException({
        message: "One or more calendar channels could not be renewed.", ...summary,
      });
    }
    return summary;
  }

  async drainSyncJobs() {
    await this.supabase.rpc("authenti8_enqueue_stale_calendar_syncs", {});
    const jobs = await this.supabase.rpc<CalendarSyncJob[]>(
      "authenti8_claim_calendar_sync_jobs", {},
    );
    const results = await Promise.all((jobs ?? []).map((job) => this.runSyncJob(job)));
    await this.supabase.rpc("authenti8_reconcile_expired_credits", {});
    return { examined: results.length,
      synchronized: results.filter((item) => item).length,
      failed: results.filter((item) => !item).length };
  }

  private async runSyncJob(job: CalendarSyncJob) {
    try {
      const credentials = await this.supabase.rpc<IntegrationCredentials>(
        "authenti8_integration_credentials_by_id", { integrationId: job.integrationId },
      );
      if (credentials?.id) await this.syncCredentials(credentials);
      await this.completeSyncJob(job, true);
      return true;
    } catch (error) {
      this.logger.error(`Calendar synchronization failed: ${errorMessage(error)}`);
      await this.completeSyncJob(job, false, syncErrorCode(error));
      return false;
    }
  }

  private completeSyncJob(job: CalendarSyncJob, success: boolean, errorCode = "") {
    return this.supabase.rpc("authenti8_complete_calendar_sync_job", {
      integrationId: job.integrationId, generation: job.generation,
      requestedAt: job.requestedAt, claimToken: job.claimToken, success, errorCode,
    });
  }

  private async syncCredentials(credentials: IntegrationCredentials) {
    const syncStartedAt = new Date().toISOString();
    const accessToken = await this.validAccessToken(credentials);
    const syncToken = fullSyncDue(credentials.lastFullSyncAt) ? null : credentials.syncToken;
    const events = await this.listEvents(credentials.calendarId, accessToken, syncToken);
    const normalized = events.items.map((item) => normalizeGoogleEvent(
      item, credentials.organizationDomain,
    )).filter(Boolean);
    return this.supabase.rpc("authenti8_apply_calendar_sync", {
      integrationId: credentials.id, generation: credentials.generation,
      calendarId: credentials.calendarId, events: normalized,
      syncToken: events.syncToken, fullSync: events.fullSync,
      syncStartedAt,
      scanWindowStart: events.window?.timeMin ?? null,
      scanWindowEnd: events.window?.timeMax ?? null,
    });
  }

  private async listEvents(
    calendarId: string,
    token: string,
    syncToken: string | null,
  ): Promise<CalendarEventResult> {
    const items: GoogleEvent[] = [];
    const window = syncToken ? undefined : calendarWindow();
    let pageToken: string | undefined;
    let finalSyncToken: string | undefined;
    do {
      const url = eventUrl(calendarId, syncToken, pageToken, window);
      let page: EventPage;
      try {
        page = await this.googleGet<EventPage>(url, token);
      } catch (error) {
        if (syncToken && error instanceof GoogleApiError && error.googleStatus === 410) {
          return this.listEvents(calendarId, token, null);
        }
        throw error;
      }
      items.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
      finalSyncToken = page.nextSyncToken ?? finalSyncToken;
    } while (pageToken);
    return { items, syncToken: finalSyncToken ?? syncToken,
      fullSync: syncToken === null, window };
  }

  private async validAccessToken(credentials: IntegrationCredentials) {
    const key = this.encryptionKey();
    if (Date.parse(credentials.expiresAt) > Date.now() + 60_000) {
      return decryptIntegrationToken(key, credentials.accessToken, credentials.organizationId);
    }
    const refresh = decryptIntegrationToken(key, credentials.refreshToken, credentials.organizationId);
    let tokens: GoogleTokenResponse;
    try {
      tokens = await this.refreshToken(refresh);
    } catch (error) {
      if (requiresGoogleReauthentication(error)) {
        await this.supabase.rpc("authenti8_mark_integration_error", {
          integrationId: credentials.id, generation: credentials.generation,
          status: "REAUTH_REQUIRED",
        });
      }
      throw error;
    }
    await this.supabase.rpc("authenti8_store_google_token", {
      integrationId: credentials.id,
      generation: credentials.generation,
      accessToken: encryptIntegrationToken(key, tokens.access_token, credentials.organizationId),
      refreshToken: tokens.refresh_token
        ? encryptIntegrationToken(key, tokens.refresh_token, credentials.organizationId) : "",
      expiresAt: expiresAt(tokens.expires_in),
    });
    return tokens.access_token;
  }

  private async storeIntegration(
    oauth: OAuthState, profile: GoogleProfile, calendar: GoogleCalendar, tokens: GoogleTokenResponse,
  ) {
    const key = this.encryptionKey();
    if (!tokens.refresh_token) throw new BadRequestException("Google did not provide offline access.");
    return this.supabase.rpc<{ id: string; generation: number }>("authenti8_upsert_google_integration", {
      organizationId: oauth.organizationId, userId: oauth.userId, subject: profile.sub,
      email: profile.email, calendarId: calendar.id, calendarName: calendar.summary ?? "Primary calendar",
      accessToken: encryptIntegrationToken(key, tokens.access_token, oauth.organizationId),
      refreshToken: encryptIntegrationToken(key, tokens.refresh_token, oauth.organizationId),
      expiresAt: expiresAt(tokens.expires_in),
    });
  }

  private async registerWatch(
    integrationId: string, generation: number, calendarId: string, accessToken: string,
    previous?: PreviousChannel,
  ) {
    const channelId = randomUUID();
    const channelToken = randomToken(32);
    const result = await this.googlePost<GoogleWatchResponse>(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/watch`,
      accessToken, { id: channelId, type: "web_hook",
      address: `${this.config.dashboardOrigin}/api/v1/integrations/google/webhook`, token: channelToken },
    );
    if (!result.resourceId) {
      throw new BadGatewayException("Google Calendar did not return a watch resource.");
    }
    const stored = await this.supabase.rpc<{ updated: boolean } | null>(
      "authenti8_store_calendar_channel", {
        integrationId, generation, channelId, resourceId: result.resourceId,
        channelTokenHash: hashToken(channelToken),
        expiresAt: new Date(Number(result.expiration ?? Date.now() + 6 * 86400_000)).toISOString(),
      },
    );
    if (!stored?.updated) {
      await this.stopChannel({ channelId, resourceId: result.resourceId }, accessToken)
        .catch(logWatchFailure);
      throw new ServiceUnavailableException("Calendar connection changed while registering updates.");
    }
    if (previous) {
      await this.stopChannel(previous, previous.accessToken).catch(logWatchFailure);
    }
  }

  private async registerInitialWatch(
    integrationId: string, generation: number, calendarId: string, accessToken: string,
    previous?: PreviousChannel,
  ) {
    try {
      await this.registerWatch(integrationId, generation, calendarId, accessToken, previous);
      return true;
    } catch (error) {
      logWatchFailure(error);
      await this.supabase.rpc("authenti8_mark_calendar_watch_error", {
        integrationId, generation, errorCode: "WATCH_REGISTRATION_FAILED",
      });
      return false;
    }
  }

  private async renewChannel(credentials: IntegrationCredentials) {
    const accessToken = await this.validAccessToken(credentials);
    const previous = credentials.channelId && credentials.channelResourceId
      ? { channelId: credentials.channelId, resourceId: credentials.channelResourceId, accessToken }
      : undefined;
    await this.registerWatch(
      credentials.id, credentials.generation, credentials.calendarId, accessToken, previous,
    );
  }

  private stopChannel(channel: { channelId: string; resourceId: string }, accessToken: string) {
    return fetch("https://www.googleapis.com/calendar/v3/channels/stop", {
      method: "POST", headers: { authorization: `Bearer ${accessToken}`,
        "content-type": "application/json" },
      body: JSON.stringify({ id: channel.channelId, resourceId: channel.resourceId }),
      signal: AbortSignal.timeout(15_000),
    }).then(async (response) => {
      if (!response.ok) throw new GoogleApiError(response.status);
    });
  }

  private async stopPreviousChannel(credentials: IntegrationCredentials | null) {
    if (!credentials?.channelId || !credentials.channelResourceId) return;
    try {
      const accessToken = await this.validAccessToken(credentials);
      await this.stopChannel({ channelId: credentials.channelId,
        resourceId: credentials.channelResourceId }, accessToken);
    } catch (error) {
      this.logger.warn(`Previous Google channel could not be stopped: ${errorMessage(error)}`);
    }
  }

  private async preparePreviousChannel(
    credentials: IntegrationCredentials | null,
  ): Promise<PreviousChannel | undefined> {
    if (!credentials?.channelId || !credentials.channelResourceId) return undefined;
    try {
      return { channelId: credentials.channelId, resourceId: credentials.channelResourceId,
        accessToken: await this.validAccessToken(credentials) };
    } catch (error) {
      this.logger.warn(`Previous Google channel could not be prepared: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private exchangeCode(code: string, verifier: string) {
    return this.tokenRequest({ code, code_verifier: verifier, redirect_uri: this.config.googleCalendarCallbackUrl,
      grant_type: "authorization_code" });
  }

  private refreshToken(refreshToken: string) {
    return this.tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  }

  private tokenRequest(values: Record<string, string>) {
    const body = new URLSearchParams({ client_id: this.config.googleClientId,
      client_secret: this.config.googleClientSecret, ...values });
    return fetch("https://oauth2.googleapis.com/token", { method: "POST", body,
      signal: AbortSignal.timeout(15_000) }).then(parseGoogleToken);
  }

  private googleGet<T>(url: string, token: string) {
    return fetch(url, { headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000) }).then(parseGoogle<T>);
  }

  private googlePost<T>(url: string, token: string, body: unknown) {
    return fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`,
      "content-type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000) }).then(parseGoogle<T>);
  }

  private authorizationUrl(state: string, verifier: string) {
    const query = new URLSearchParams({ client_id: this.config.googleClientId,
      redirect_uri: this.config.googleCalendarCallbackUrl, response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/calendar.readonly",
      access_type: "offline", prompt: "consent", state,
      code_challenge: codeChallenge(verifier), code_challenge_method: "S256" });
    return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
  }

  private encryptionKey() {
    const value = this.config.integrationEncryptionKey;
    if (!value) throw new BadRequestException("Integration encryption is not configured.");
    return Buffer.from(value, "base64");
  }

  private assertConfigured() {
    if (!this.config.googleClientId || !this.config.googleClientSecret) {
      throw new BadRequestException("Google integration is not configured.");
    }
    this.encryptionKey();
  }
}

type OAuthState = { organizationId: string; userId: string; verifier: string };
type CalendarSyncJob = {
  integrationId: string;
  generation: number;
  requestedAt: string;
  claimToken: string;
};

type PreviousChannel = { channelId: string; resourceId: string; accessToken: string };
type CalendarWindow = { timeMin: string; timeMax: string };
type CalendarEventResult = {
  items: GoogleEvent[];
  syncToken: string | null | undefined;
  fullSync: boolean;
  window?: CalendarWindow;
};

export function eventUrl(
  calendarId: string,
  syncToken: string | null,
  pageToken?: string,
  window = syncToken ? undefined : calendarWindow(),
) {
  const query = new URLSearchParams({ singleEvents: "true", showDeleted: "true", maxResults: "2500" });
  if (syncToken) query.set("syncToken", syncToken);
  else if (window) {
    query.set("timeMin", window.timeMin);
    query.set("timeMax", window.timeMax);
  }
  if (pageToken) query.set("pageToken", pageToken);
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${query}`;
}

export function fullSyncDue(lastFullSyncAt: string | null, now = Date.now()) {
  return !lastFullSyncAt || !Number.isFinite(Date.parse(lastFullSyncAt))
    || now - Date.parse(lastFullSyncAt) >= 24 * 3600_000;
}

function calendarWindow(now = Date.now()) {
  return {
    timeMin: new Date(now - 86400_000).toISOString(),
    timeMax: new Date(now + 90 * 86400_000).toISOString(),
  };
}

async function parseGoogle<T>(response: Response) {
  if (!response.ok) throw new GoogleApiError(response.status);
  return response.json() as Promise<T>;
}

async function parseGoogleToken(response: Response) {
  if (response.ok) return response.json() as Promise<GoogleTokenResponse>;
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  const googleCode = typeof payload?.error === "string" ? payload.error : undefined;
  throw new GoogleApiError(response.status, googleCode);
}

export class GoogleApiError extends BadGatewayException {
  constructor(readonly googleStatus: number, readonly googleCode?: string) {
    super(`Google API failed (${googleStatus}).`);
  }
}

export function requiresGoogleReauthentication(error: unknown) {
  return error instanceof GoogleApiError && error.googleCode === "invalid_grant";
}

function expiresAt(seconds: number) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function logWatchFailure(error: unknown) {
  console.warn("[calendar] push channel registration failed", error);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Google Calendar error";
}

function syncErrorCode(error: unknown) {
  return error instanceof GoogleApiError ? `GOOGLE_${error.googleStatus}` : "SYNC_FAILED";
}
