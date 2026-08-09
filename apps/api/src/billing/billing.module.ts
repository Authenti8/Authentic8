import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { SupabaseModule } from "../supabase/supabase.module.js";
import { BillingController } from "./billing.controller.js";
import { BillingService } from "./billing.service.js";
import { BillingWebhookWorker } from "./billing-webhook-worker.service.js";
import { BillingWebhookWorkerController } from "./billing-webhook-worker.controller.js";

@Module({
  imports: [AuthModule, SupabaseModule],
  controllers: [BillingController, BillingWebhookWorkerController],
  providers: [BillingService, BillingWebhookWorker],
})
export class BillingModule {}
