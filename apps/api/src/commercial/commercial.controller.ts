import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { RateLimiterService } from "../auth/rate-limiter.service.js";
import { SessionGuard } from "../auth/session.guard.js";
import { CommercialService } from "./commercial.service.js";
import { CommercialOrganizationQueryDto, CommercialOverviewQueryDto, ConvertLeadDto,
  ManageStaffDto, SubmitLeadDto, UpdateLeadDto } from "./commercial.dto.js";

@Controller("commercial")
export class CommercialController {
  constructor(private readonly commercial: CommercialService,
    private readonly rateLimiter: RateLimiterService) {}

  @Post("leads")
  async submit(@Body() body: SubmitLeadDto, @Req() request: Request) {
    const normalizedEmail = body.email.trim().toLowerCase();
    await this.rateLimiter.consume(`commercial:lead:ip:${request.ip ?? "unknown"}`, 8, 60 * 60_000);
    await this.rateLimiter.consume(`commercial:lead:email:${normalizedEmail}`, 3, 24 * 60 * 60_000);
    return this.commercial.submit({ ...body, email: normalizedEmail });
  }

  @Get("overview")
  @UseGuards(SessionGuard)
  overview(@Req() request: AuthenticatedRequest, @Query() query: CommercialOverviewQueryDto) {
    return this.commercial.overview(request.session!.userId, { ...query, ...decodeCursor(query.cursor) });
  }

  @Get("organizations")
  @UseGuards(SessionGuard)
  organizations(@Req() request: AuthenticatedRequest,
    @Query() query: CommercialOrganizationQueryDto) {
    return this.commercial.organizations(request.session!.userId, query.query);
  }

  @Post("staff")
  @UseGuards(SessionGuard)
  staff(@Body() body: ManageStaffDto, @Req() request: AuthenticatedRequest) {
    return this.commercial.manageStaff(request.session!.userId, body);
  }

  @Post("leads/update")
  @UseGuards(SessionGuard)
  update(@Body() body: UpdateLeadDto, @Req() request: AuthenticatedRequest) {
    return this.commercial.updateLead(request.session!.userId, body);
  }

  @Post("leads/convert")
  @UseGuards(SessionGuard)
  convert(@Body() body: ConvertLeadDto, @Req() request: AuthenticatedRequest) {
    return this.commercial.convertLead(request.session!.userId, body);
  }
}

function decodeCursor(cursor?: string) {
  if (!cursor) return {};
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as
      { updatedAt?: unknown; id?: unknown };
    if (typeof decoded.updatedAt !== "string" || !Number.isFinite(Date.parse(decoded.updatedAt))
        || typeof decoded.id !== "string" || !/^[0-9a-f-]{36}$/i.test(decoded.id)) throw new Error();
    return { cursorUpdatedAt: decoded.updatedAt, cursorId: decoded.id };
  } catch { throw new BadRequestException("Invalid commercial cursor."); }
}
