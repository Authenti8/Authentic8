import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { SupabaseModule } from "../supabase/supabase.module.js";
import { AdminController, OperationsController } from "./admin.controller.js";

@Module({ imports: [AuthModule, SupabaseModule], controllers: [AdminController, OperationsController] })
export class AdminModule {}
