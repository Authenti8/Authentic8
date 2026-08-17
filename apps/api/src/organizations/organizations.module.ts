import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { OrganizationsController } from "./organizations.controller.js";
import { OrganizationsService } from "./organizations.service.js";
import { MembersController } from "./members.controller.js";
import { MembersService } from "./members.service.js";

@Module({
  imports: [AuthModule],
  controllers: [OrganizationsController, MembersController],
  providers: [OrganizationsService, MembersService],
})
export class OrganizationsModule {}
