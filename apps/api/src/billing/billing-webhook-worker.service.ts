import { Inject, Injectable, Logger } from "@nestjs/common";
import { SupabaseService } from "../supabase/supabase.service.js";
import { BillingService, type DodoEvent } from "./billing.service.js";

type BillingWebhookJob = {
  eventId: string;
  claimToken: string;
  payload: DodoEvent;
};

@Injectable()
export class BillingWebhookWorker {
  private readonly logger = new Logger(BillingWebhookWorker.name);

  constructor(
    @Inject(SupabaseService) private readonly supabase: SupabaseService,
    @Inject(BillingService) private readonly billing: BillingService,
  ) {}

  enqueue(event: DodoEvent & { id: string }) {
    return this.supabase.rpc("authenti8_enqueue_billing_webhook", {
      eventId: event.id,
      eventType: event.type,
      payload: event,
    });
  }

  async drain() {
    const jobs = await this.supabase.rpc<BillingWebhookJob[]>(
      "authenti8_claim_billing_webhooks", {},
    );
    const results = await Promise.all((jobs ?? []).map((job) => this.process(job)));
    return {
      examined: results.length,
      processed: results.filter(Boolean).length,
      failed: results.filter((result) => !result).length,
    };
  }

  private async process(job: BillingWebhookJob) {
    try {
      await this.billing.applyWebhook({ ...job.payload, id: job.eventId });
      await this.complete(job, true);
      return true;
    } catch (error) {
      const code = webhookErrorCode(error);
      this.logger.error(`Dodo webhook ${job.eventId} failed: ${code}`);
      await this.complete(job, false, code);
      return false;
    }
  }

  private complete(job: BillingWebhookJob, success: boolean, errorCode = "") {
    return this.supabase.rpc("authenti8_complete_billing_webhook", {
      eventId: job.eventId,
      claimToken: job.claimToken,
      success,
      errorCode,
    });
  }
}

function webhookErrorCode(error: unknown) {
  if (!(error instanceof Error)) return "UNKNOWN_ERROR";
  return error.name.replace(/[^A-Z0-9_]/gi, "_").toUpperCase().slice(0, 80) || "ERROR";
}
