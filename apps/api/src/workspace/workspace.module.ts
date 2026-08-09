import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { SupabaseModule } from "../supabase/supabase.module.js";
import { WorkspaceController, WorkspaceMaintenanceController } from "./workspace.controller.js";

@Module({
  imports: [AuthModule, SupabaseModule],
  controllers: [WorkspaceController, WorkspaceMaintenanceController],
})
export class WorkspaceModule {}
