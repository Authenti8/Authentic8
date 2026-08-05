import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { OrganizationsController } from "./organizations.controller.js";
import { OrganizationsService } from "./organizations.service.js";

@Module({
  imports: [AuthModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService],
})
export class OrganizationsModule {}
