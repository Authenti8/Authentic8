import { Inject, Injectable, Logger } from "@nestjs/common";
import { deriveEnrollmentToken, hashToken, randomToken } from "../auth/crypto.js";
import { MailService } from "../auth/mail.service.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import type {
  CandidateConsentResult, CandidateVerification, VerificationDeliveryJob,
  EnrollmentPreparation,
} from "./interview.types.js";

const DRAIN_RUNTIME_BUDGET_MS = 50_000;
const DELIVERY_RUNTIME_RESERVE_MS = 32_000;

@Injectable()
export class InterviewLifecycleService {
  private readonly logger = new Logger(InterviewLifecycleService.name);

  constructor(
    @Inject(SupabaseService) private readonly supabase: SupabaseService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  async drain() {
    const deadline = Date.now() + DRAIN_RUNTIME_BUDGET_MS;
    const lifecycle = await this.supabase.rpc<Record<string, number>>(
      "authenti8_orchestrate_interviews", {},
    );
    const monitoring = await this.supabase.rpc<Record<string, number>>(
      "authenti8_orchestrate_monitoring", {},
    );
    const reports = await this.supabase.rpc<Record<string, number>>(
      "authenti8_process_reports", {},
    );
    let delivered = 0;
    let failed = 0;
    while (Date.now() + DELIVERY_RUNTIME_RESERVE_MS < deadline) {
      const result = await this.deliverNext();
      if (result === "empty") break;
      if (result === "delivered") delivered += 1;
      if (result === "failed") failed += 1;
    }
    return { ...lifecycle, ...monitoring, ...reports, delivered, failed };
  }

  verification(token: string) {
    return this.supabase.rpc<CandidateVerification>("authenti8_candidate_verification", {
      tokenHash: hashToken(token),
    });
  }

  async consent(token: string, decision: string, consentVersion: string, context: ConsentContext) {
    const result = await this.supabase.rpc<CandidateConsentResult>("authenti8_record_candidate_consent", {
      tokenHash: hashToken(token), decision, consentVersion,
      ipAddress: context.ipAddress, userAgent: context.userAgent,
    });
    if (!result.accepted || !result.verificationSessionId) return result;
    const enrollmentToken = deriveEnrollmentToken(token);
    const enrollment = await this.supabase.rpc<EnrollmentPreparation>(
      "authenti8_prepare_device_enrollment",
      { verificationSessionId: result.verificationSessionId,
        secretHash: hashToken(enrollmentToken) },
    );
    if (!enrollment.prepared) {
      return { accepted: false, reason: "INTERVIEW_UNAVAILABLE" };
    }
    return { ...result, enrollmentToken,
      enrollmentExpiresAt: enrollment.expiresAt };
  }

  endCandidateMonitoring(token: string) {
    return this.supabase.rpc("authenti8_candidate_end_monitoring", { tokenHash: hashToken(token) });
  }

  endRecruiterMonitoring(userId: string, interviewId: string) {
    return this.supabase.rpc("authenti8_recruiter_end_monitoring", { userId, interviewId });
  }

  private async deliverNext() {
    const job = await this.supabase.rpc<VerificationDeliveryJob | null>(
      "authenti8_claim_verification_delivery", {},
    );
    if (!job) return "empty" as const;
    if (job.skipped) return "skipped" as const;
    if (!validJob(job)) return "failed" as const;
    const token = randomToken(32);
    try {
      const outbox = this.mail.prepareOutbox(
        job.candidateEmail, "candidate_verification", token,
      );
      const completion = await this.supabase.rpc<DeliveryCompletion | null>(
        "authenti8_complete_verification_delivery", {
          interviewId: job.interviewId, claimToken: job.claimToken,
          attempts: job.attempts, tokenHash: hashToken(token), ...outbox,
        },
      );
      if (!completion?.completed) return "skipped" as const;
      if (!this.mail.usesDurableOutbox) await this.mail.drainPending();
      return "delivered" as const;
    } catch (error) {
      await this.fail(job, error);
      return "failed" as const;
    }
  }

  private async fail(job: RequiredJob, error: unknown) {
    const reason = error instanceof Error ? error.message : "Unknown delivery failure";
    this.logger.error(`Verification delivery failed: ${reason}`);
    await this.supabase.rpc("authenti8_fail_verification_delivery", {
      interviewId: job.interviewId, claimToken: job.claimToken,
      attempts: job.attempts, error: reason.slice(0, 500),
    });
  }
}

type ConsentContext = { ipAddress: string; userAgent: string };
type DeliveryCompletion = { completed?: boolean; skipped?: boolean };
type RequiredJob = Required<Pick<VerificationDeliveryJob,
  "interviewId" | "candidateEmail" | "claimToken" | "attempts">>;

function validJob(job: VerificationDeliveryJob): job is VerificationDeliveryJob & RequiredJob {
  return Boolean(job.interviewId && job.candidateEmail && job.claimToken
    && Number.isInteger(job.attempts));
}
