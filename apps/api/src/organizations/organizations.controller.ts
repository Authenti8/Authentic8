import { Body, Controller, Inject, Post, Req, UseGuards } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { SessionGuard } from "../auth/session.guard.js";
import { CreateOrganizationDto } from "./organizations.dto.js";
import { OrganizationsService } from "./organizations.service.js";

@Controller("organizations")
@UseGuards(SessionGuard)
export class OrganizationsController {
  constructor(@Inject(OrganizationsService) private readonly organizations: OrganizationsService) {}

  @Post()
  create(@Req() request: AuthenticatedRequest, @Body() input: CreateOrganizationDto) {
    return this.organizations.create(request.session!.userId, input);
  }
}
