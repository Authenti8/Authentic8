import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { SupabaseModule } from "../supabase/supabase.module.js";
import { CandidateController } from "./candidate.controller.js";
import { InterviewLifecycleService } from "./interview-lifecycle.service.js";
import { InterviewMaintenanceController } from "./interview-maintenance.controller.js";

@Module({
  imports: [AuthModule, SupabaseModule],
  controllers: [CandidateController, InterviewMaintenanceController],
  providers: [InterviewLifecycleService],
})
export class InterviewsModule {}
