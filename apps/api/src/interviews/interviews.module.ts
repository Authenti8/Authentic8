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
import { MonitoringController, ReportWorkerController } from "./monitoring.controller.js";
import { RecruiterExtensionController } from "./recruiter-extension.controller.js";
import { RecruiterExtensionService } from "./recruiter-extension.service.js";

@Module({
  imports: [AuthModule, SupabaseModule],
  controllers: [CandidateController, DeviceEnrollmentController, InterviewMaintenanceController,
    AgentReleaseController, TelemetryController, MonitoringController, ReportWorkerController,
    RecruiterExtensionController],
  providers: [DeviceEnrollmentService, InterviewLifecycleService, TelemetryService,
    RecruiterExtensionService],
})
export class InterviewsModule {}
