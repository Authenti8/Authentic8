import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { SupabaseModule } from "../supabase/supabase.module.js";
import { GoogleCalendarService } from "./google-calendar.service.js";
import { IntegrationMaintenanceController, IntegrationsController } from "./integrations.controller.js";

@Module({
  imports: [AuthModule, SupabaseModule],
  controllers: [IntegrationsController, IntegrationMaintenanceController],
  providers: [GoogleCalendarService],
})
export class IntegrationsModule {}
