import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { SupabaseModule } from "../supabase/supabase.module.js";
import { CandidateController } from "./candidate.controller.js";
import { DeviceEnrollmentController } from "./device-enrollment.controller.js";
import { DeviceEnrollmentService } from "./device-enrollment.service.js";
import { InterviewLifecycleService } from "./interview-lifecycle.service.js";
import { InterviewMaintenanceController } from "./interview-maintenance.controller.js";
import { AgentReleaseController, TelemetryController } from "./telemetry.controller.js";
import { TelemetryService } from "./telemetry.service.js";
import { MonitoringController } from "./monitoring.controller.js";

@Module({
  imports: [AuthModule, SupabaseModule],
  controllers: [CandidateController, DeviceEnrollmentController, InterviewMaintenanceController,
    AgentReleaseController, TelemetryController, MonitoringController],
  providers: [DeviceEnrollmentService, InterviewLifecycleService, TelemetryService],
})
export class InterviewsModule {}
