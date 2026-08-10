import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module.js";
import { BillingModule } from "./billing/billing.module.js";
import { HealthController } from "./health.controller.js";
import { IntegrationsModule } from "./integrations/integrations.module.js";
import { InterviewsModule } from "./interviews/interviews.module.js";
import { OrganizationsModule } from "./organizations/organizations.module.js";
import { SupabaseModule } from "./supabase/supabase.module.js";
import { WorkspaceModule } from "./workspace/workspace.module.js";

@Module({
  imports: [
    SupabaseModule, AuthModule, OrganizationsModule, BillingModule,
    IntegrationsModule, InterviewsModule, WorkspaceModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
