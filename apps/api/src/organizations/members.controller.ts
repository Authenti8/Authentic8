import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { SessionGuard } from "../auth/session.guard.js";
import { ActiveOrganizationGuard } from "../auth/active-organization.guard.js";
import { AcceptInvitationDto, AdjustWalletDto, InviteMemberDto, ManageBillingGrantDto,
  ManageMemberDto } from "./members.dto.js";
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

  @Get("billing-grants")
  @UseGuards(ActiveOrganizationGuard)
  billingGrants(@Req() request: AuthenticatedRequest) {
    return this.members.billingGrants(request.session!.userId);
  }

  @Post("billing-grants")
  @UseGuards(ActiveOrganizationGuard)
  billingGrant(@Body() body: ManageBillingGrantDto, @Req() request: AuthenticatedRequest) {
    return this.members.manageBillingGrant(request.session!.userId, body);
  }

  @Get("wallets")
  @UseGuards(ActiveOrganizationGuard)
  wallets(@Req() request: AuthenticatedRequest) {
    return this.members.wallets(request.session!.userId);
  }

  @Post("wallets")
  @UseGuards(ActiveOrganizationGuard)
  wallet(@Body() body: AdjustWalletDto, @Req() request: AuthenticatedRequest) {
    return this.members.adjustWallet(request.session!.userId, body);
  }
}
