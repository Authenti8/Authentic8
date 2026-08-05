import { Controller, Get, Inject } from "@nestjs/common";
import { telemetrySchemaVersion } from "@authenti8/event-schemas";
import { SupabaseService } from "./supabase/supabase.service.js";

@Controller("health")
export class HealthController {
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  @Get()
  async health() {
    await this.supabase.rpc("authenti8_health");
    return { status: "ok", service: "authenti8-api", telemetrySchemaVersion };
  }
}
