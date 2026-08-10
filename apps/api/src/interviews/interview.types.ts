export type VerificationDeliveryJob = {
  skipped?: boolean;
  interviewId?: string;
  candidateEmail?: string;
  candidateName?: string | null;
  title?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  claimToken?: string;
  attempts?: number;
};

export type CandidateVerification = {
  valid: boolean;
  reason?: "NOT_FOUND" | "ALREADY_USED" | "EXPIRED" | "INTERVIEW_UNAVAILABLE";
  organizationName?: string;
  interviewTitle?: string;
  candidateName?: string | null;
  candidateEmail?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  expiresAt?: string;
  consentVersion?: string;
};

export type CandidateConsentResult = {
  accepted: boolean;
  declined?: boolean;
  verificationSessionId?: string;
  reason?: "NOT_FOUND" | "ALREADY_USED" | "INTERVIEW_UNAVAILABLE" | "CONSENT_VERSION_CHANGED";
};
