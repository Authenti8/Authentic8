import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthController } from "./health.controller.js";
import { OrganizationsModule } from "./organizations/organizations.module.js";

@Module({
  imports: [DatabaseModule, AuthModule, OrganizationsModule],
  controllers: [HealthController],
})
export class AppModule {}
