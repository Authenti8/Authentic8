import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { SupabaseService } from "../supabase/supabase.service.js";

@Injectable()
export class OperationalFailureService {
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  async record(input: FailureInput) {
    const identity = [input.component, input.organizationId, input.interviewId,
      input.reference, input.errorCode].filter(Boolean).join(":");
    const idempotencyKey = `${input.component.toLowerCase()}:${digest(identity)}`;
    try {
      await this.supabase.rpc("authenti8_record_operational_failure", {
        component: input.component, organizationId: input.organizationId,
        interviewId: input.interviewId, idempotencyKey, errorCode: input.errorCode,
        safeMessage: input.safeMessage, context: input.context ?? {},
      });
    } catch {
      // Observability must never replace the original application failure.
    }
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export type FailureComponent = "OAUTH_REFRESH" | "LIVE_STREAM" | "AGENT_ENROLLMENT"
  | "TELEMETRY_INGESTION" | "DETECTION_RULE";

type FailureInput = { component: FailureComponent; errorCode: string; safeMessage: string;
  reference?: string; organizationId?: string; interviewId?: string;
  context?: Readonly<Record<string, unknown>> };
