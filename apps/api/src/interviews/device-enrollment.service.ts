import { Inject, Injectable } from "@nestjs/common";
import { hashToken } from "../auth/crypto.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { publicKeyFingerprint, verifyEnrollmentSignature } from "./enrollment-crypto.js";
import type { DeviceEnrollmentInput, EnrollmentChallengeResult } from "./enrollment.types.js";

@Injectable()
export class DeviceEnrollmentService {
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  challenge(token: string) {
    return this.supabase.rpc<EnrollmentChallengeResult>(
      "authenti8_device_enrollment_challenge", { tokenHash: hashToken(token) },
    );
  }

  async complete(input: DeviceEnrollmentInput) {
    let fingerprint: string;
    try { fingerprint = publicKeyFingerprint(input.publicKey); }
    catch { return { enrolled: false, reason: "INVALID_SIGNATURE" }; }
    const challenge = await this.challenge(input.token);
    if (!challenge.valid || !challenge.challenge || !challenge.verificationSessionId) {
      return this.supabase.rpc("authenti8_replay_device_enrollment", {
        tokenHash: hashToken(input.token), publicKeyFingerprint: fingerprint,
      });
    }
    const signatureVerified = verifyEnrollmentSignature({
      publicKey: input.publicKey, signature: input.challengeSignature,
      challenge: challenge.challenge, sessionId: challenge.verificationSessionId,
    });
    if (!signatureVerified) return { enrolled: false, reason: "INVALID_SIGNATURE" };
    return this.supabase.rpc("authenti8_complete_device_enrollment", {
      tokenHash: hashToken(input.token), publicKey: input.publicKey,
      publicKeyFingerprint: fingerprint, signatureVerified,
      platform: input.platform, platformVersion: input.platformVersion,
      agentVersion: input.agentVersion, deviceName: input.deviceName ?? "",
    });
  }
}
