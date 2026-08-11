export type UserRole = "OWNER" | "ADMIN" | "RECRUITER" | "VIEWER";

export type SessionUser = {
  id: string;
  email: string;
  fullName: string;
  emailVerified: boolean;
};

export type OrganizationSummary = {
  id: string;
  name: string;
  domain: string;
  role: UserRole;
};

export type SessionResponse = {
  user: SessionUser;
  organization: OrganizationSummary | null;
};

export type ApiErrorResponse = {
  error: string;
  fields?: Record<string, string[]>;
};

export type AuthResponse = {
  message: string;
  next?: string;
  previewUrl?: string;
};

export type OnboardingResponse = {
  organization: OrganizationSummary;
  next: string;
};

export type PlanKey = "STARTER" | "PROFESSIONAL" | "ENTERPRISE";

export type BillingSummary = {
  plan: PlanKey;
  status: string;
  allowance: number;
  balance: number;
  used: number;
  periodStart: string;
  periodEnd: string;
  cancelAtPeriodEnd: boolean;
};

export type DashboardOverview = BillingSummary & {
  upcoming: number;
  completed: number;
  confirmed: number;
  failed: number;
  integrationActive: boolean;
  notificationCount: number;
  recentReports: RecentReport[];
};

export type RecentReport = {
  interviewId: string;
  title: string;
  result: string;
  generatedAt: string;
};

export type IntegrationSummary = {
  provider: "GOOGLE_MEET";
  status: "NOT_CONNECTED" | "ACTIVE" | "REAUTH_REQUIRED" | "ERROR";
  connectedEmail: string | null;
  calendarName: string | null;
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
};

export type InterviewSummary = {
  id: string;
  title: string;
  candidateEmail: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: string;
  protectionStatus: "PENDING" | "RESERVED" | "CONSUMED" | "RELEASED"
    | "UNPROTECTED_NO_CREDITS" | "UNPROTECTED_SUBSCRIPTION";
  meetUrl: string;
  classificationReason: string | null;
  consentStatus: string;
  verificationDeliveryStatus: "NOT_SCHEDULED" | "SCHEDULED" | "QUEUED" | "SENT" | "FAILED";
};

export type CandidateVerification = {
  valid: true;
  organizationName: string;
  interviewTitle: string;
  candidateName: string | null;
  candidateEmail: string;
  scheduledStart: string;
  scheduledEnd: string;
  expiresAt: string;
  consentVersion: string;
};

export type CandidateConsentResponse = {
  accepted: boolean;
  declined?: boolean;
  verificationSessionId?: string;
  enrollmentToken?: string;
  enrollmentExpiresAt?: string;
  reason?: string;
};

export type EnrollmentChallenge = {
  verificationSessionId: string;
  challenge: string;
  expiresAt: string;
};

export type DeviceEnrollmentRequest = {
  token: string;
  publicKey: string;
  challengeSignature: string;
  platform: "WINDOWS" | "MACOS";
  platformVersion: string;
  agentVersion: string;
  deviceName?: string;
};

export type DeviceEnrollmentResponse = {
  enrolled: true;
  deviceId: string;
  verificationSessionId: string;
  eligibleStart: string;
  eligibleEnd: string;
};
