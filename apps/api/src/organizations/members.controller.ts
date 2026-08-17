import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ActiveOrganizationGuard } from "../auth/active-organization.guard.js";
import { AcceptInvitationDto, InviteMemberDto, ManageMemberDto } from "./members.dto.js";
import { MembersService } from "./members.service.js";

@Controller("organization/members")
@UseGuards(SessionGuard)
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @UseGuards(ActiveOrganizationGuard)
  overview(@Req() request: AuthenticatedRequest) {
    return this.members.overview(request.session!.userId);
  }

  @Post("invite")
  @UseGuards(ActiveOrganizationGuard)
  invite(@Body() body: InviteMemberDto, @Req() request: AuthenticatedRequest) {
    return this.members.invite(request.session!.userId, body);
  }

  @Post("accept")
  accept(@Body() body: AcceptInvitationDto, @Req() request: AuthenticatedRequest) {
    return this.members.accept(request.session!.userId, body.token);
  }

  @Post("manage")
  @UseGuards(ActiveOrganizationGuard)
  manage(@Body() body: ManageMemberDto, @Req() request: AuthenticatedRequest) {
    return this.members.manage(request.session!.userId, body);
  }
}
