import {
  BadRequestException, Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Query, Req,
  UnauthorizedException, UseGuards,
} from "@nestjs/common";
import type { DashboardOverview, MeetingDetail, MeetingsPage,
  WorkspaceNotification } from "@authenti8/contracts";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { validBearerToken } from "../auth/bearer.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ActiveOrganizationGuard } from "../auth/active-organization.guard.js";
import { loadConfig } from "../config.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { ReassignInterviewDto } from "./workspace.dto.js";

@Controller()
@UseGuards(SessionGuard, ActiveOrganizationGuard)
export class WorkspaceController {
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  @Get("overview")
  overview(@Req() request: AuthenticatedRequest) {
    return this.supabase.rpc<DashboardOverview>("authenti8_dashboard_overview", {
      userId: request.session!.userId,
    });
  }

  @Get("meetings")
  async meetings(@Req() request: AuthenticatedRequest,
    @Query() query: Record<string, string | undefined>) {
    const result = await this.supabase.rpc<MeetingsPage & { invalid?: boolean }>(
      "authenti8_meetings_page", {
        userId: request.session!.userId, ...meetingQuery(query),
      });
    if (result.invalid) throw new BadRequestException("Invalid meeting filters.");
    return result;
  }

  @Get("meetings/:id")
  async meeting(@Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) interviewId: string) {
    const result = await this.supabase.rpc<MeetingDetail | null>("authenti8_meeting_detail", {
      userId: request.session!.userId, interviewId,
    });
    if (!result) throw new BadRequestException("Meeting is unavailable.");
    return result;
  }

  @Post("meetings/:id/assign")
  async assignMeeting(@Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) interviewId: string, @Body() body: ReassignInterviewDto) {
    const result = await this.supabase.rpc<{ updated: boolean; reason?: string }>(
      "authenti8_reassign_interview", { userId: request.session!.userId,
        interviewId, memberUserId: body.memberUserId });
    if (!result.updated) throw new BadRequestException(result.reason ?? "Assignment failed.");
    return result;
  }

  @Get("notifications")
  notifications(@Req() request: AuthenticatedRequest) {
    return this.supabase.rpc<WorkspaceNotification[]>("authenti8_notifications", {
      userId: request.session!.userId,
    });
  }

  @Post("notifications/acknowledge")
  acknowledgeNotifications(@Req() request: AuthenticatedRequest) {
    return this.supabase.rpc<{ acknowledged: number }>("authenti8_acknowledge_notifications", {
      userId: request.session!.userId,
    });
  }

}

const meetingStatuses = new Set(["UPCOMING", "LIVE", "COMPLETED", "CONFIRMED",
  "NOT_DETECTED", "UNABLE_TO_VERIFY", "CANCELLED"]);

function meetingQuery(query: Record<string, string | undefined>) {
  const status = query.status?.toUpperCase();
  if (status && !meetingStatuses.has(status)) throw new BadRequestException("Invalid status filter.");
  return { status, from: query.from, to: query.to, interviewer: clean(query.interviewer, 320),
    candidate: clean(query.candidate, 200), limit: meetingLimit(query.limit),
    ...decodeMeetingCursor(query.cursor) };
}

function meetingLimit(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,2}$/.test(value)) {
    throw new BadRequestException("Meeting limit must be an integer between 1 and 100.");
  }
  const limit = Number(value);
  if (limit > 100) throw new BadRequestException("Meeting limit must be an integer between 1 and 100.");
  return limit;
}

function clean(value: string | undefined, maximum: number) {
  const result = value?.trim();
  if (result && result.length > maximum) throw new BadRequestException("Meeting filter is too long.");
  return result;
}

function decodeMeetingCursor(cursor: string | undefined) {
  if (!cursor) return {};
  try {
    const [cursorStart, cursorId, extra] = Buffer.from(cursor, "base64").toString("utf8").split("|");
    if (!cursorStart || !cursorId || extra || !/^[0-9a-f-]{36}$/i.test(cursorId)) throw new Error();
    return { cursorStart, cursorId };
  } catch { throw new BadRequestException("Invalid meeting cursor."); }
}

@Controller("internal/workspace")
export class WorkspaceMaintenanceController {
  private readonly config = loadConfig();
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  @Post("meetings/:id/reserve")
  reserve(@Headers("authorization") authorization: string | undefined,
    @Param("id", ParseUUIDPipe) id: string) {
    this.authorize(authorization);
    return this.supabase.rpc("authenti8_reserve_credit", { interviewId: id });
  }

  @Post("meetings/:id/consume")
  consume(@Headers("authorization") authorization: string | undefined,
    @Param("id", ParseUUIDPipe) id: string) {
    this.authorize(authorization);
    return this.supabase.rpc("authenti8_consume_credit", { interviewId: id });
  }

  @Post("meetings/:id/release")
  release(@Headers("authorization") authorization: string | undefined,
    @Param("id", ParseUUIDPipe) id: string) {
    this.authorize(authorization);
    return this.supabase.rpc("authenti8_release_credit", { interviewId: id });
  }

  private authorize(authorization: string | undefined) {
    if (!validBearerToken(authorization, this.config.cronSecret)) {
      throw new UnauthorizedException();
    }
  }
}
