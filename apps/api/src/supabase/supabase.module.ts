import { Global, Module } from "@nestjs/common";
import { SupabaseService } from "./supabase.service.js";
import { OperationalFailureService } from "../observability/operational-failure.service.js";

@Global()
@Module({ providers: [SupabaseService, OperationalFailureService],
  exports: [SupabaseService, OperationalFailureService] })
export class SupabaseModule {}
