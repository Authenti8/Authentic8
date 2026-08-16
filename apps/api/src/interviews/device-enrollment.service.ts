import { Inject, Injectable } from "@nestjs/common";
import { hashToken } from "../auth/crypto.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { publicKeyFingerprint, verifyEnrollmentSignature } from "./enrollment-crypto.js";
import type { DeviceEnrollmentInput, EnrollmentChallengeResult } from "./enrollment.types.js";
import { OperationalFailureService } from "../observability/operational-failure.service.js";

@Injectable()
export class DeviceEnrollmentService {
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService,
    @Inject(OperationalFailureService) private readonly failures: OperationalFailureService) {}

  async challenge(token: string) {
    const tokenHash = hashToken(token);
    try {
      return await this.supabase.rpc<EnrollmentChallengeResult>(
        "authenti8_device_enrollment_challenge", { tokenHash });
    } catch (error) {
      await this.recordFailure(tokenHash, "ENROLLMENT_CHALLENGE_FAILED");
      throw error;
    }
  }

  async complete(input: DeviceEnrollmentInput) {
    let fingerprint: string;
    try { fingerprint = publicKeyFingerprint(input.publicKey); }
    catch { return { enrolled: false, reason: "INVALID_SIGNATURE" }; }
    const challenge = await this.challenge(input.token);
    if (!challenge.valid || !challenge.challenge || !challenge.verificationSessionId) {
      const tokenHash = hashToken(input.token);
      try {
        return await this.supabase.rpc("authenti8_replay_device_enrollment", {
          tokenHash, publicKeyFingerprint: fingerprint,
        });
      } catch (error) {
        await this.recordFailure(tokenHash, "ENROLLMENT_REPLAY_FAILED");
        throw error;
      }
    }
    const signatureVerified = verifyEnrollmentSignature({
      publicKey: input.publicKey, signature: input.challengeSignature,
      challenge: challenge.challenge, sessionId: challenge.verificationSessionId,
    });
    if (!signatureVerified) return { enrolled: false, reason: "INVALID_SIGNATURE" };
    try {
      return await this.supabase.rpc("authenti8_complete_device_enrollment", {
        tokenHash: hashToken(input.token), publicKey: input.publicKey,
        publicKeyFingerprint: fingerprint, signatureVerified,
        platform: input.platform, platformVersion: input.platformVersion,
        agentVersion: input.agentVersion, deviceName: input.deviceName ?? "",
      });
    } catch (error) {
      await this.recordFailure(hashToken(input.token), "ENROLLMENT_COMPLETION_FAILED");
      throw error;
    }
  }

  private recordFailure(reference: string, errorCode: string) {
    return this.failures.record({ component: "AGENT_ENROLLMENT", errorCode,
      safeMessage: "Agent enrollment failed.", reference });
  }
}
