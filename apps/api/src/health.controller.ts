import { Controller, Get, Inject } from "@nestjs/common";
import { telemetrySchemaVersion } from "@authenti8/event-schemas";
import { DatabaseService } from "./database/database.service.js";

@Controller("health")
export class HealthController {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  @Get()
  async health() {
    await this.db.query("SELECT 1");
    return { status: "ok", service: "authenti8-api", telemetrySchemaVersion };
  }
}
