import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module.js";
import { HealthController } from "./health.controller.js";
import { OrganizationsModule } from "./organizations/organizations.module.js";
import { SupabaseModule } from "./supabase/supabase.module.js";

@Module({
  imports: [SupabaseModule, AuthModule, OrganizationsModule],
  controllers: [HealthController],
})
export class AppModule {}
