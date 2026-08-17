export type UserRole = "OWNER" | "MANAGER" | "HR";

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
  includedUsed: number;
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
  candidateName?: string | null;
  candidateEmail: string;
  interviewerEmail?: string;
  responsibleMemberUserId?: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  status: string;
  protectionStatus: "PENDING" | "RESERVED" | "CONSUMED" | "RELEASED"
    | "UNPROTECTED_NO_CREDITS" | "UNPROTECTED_SUBSCRIPTION";
  meetUrl: string;
  classificationReason: string | null;
  consentStatus: string;
  verificationDeliveryStatus: "NOT_SCHEDULED" | "SCHEDULED" | "QUEUED" | "SENT" | "FAILED";
  detectionResult?: string | null;
  coveragePercentage?: number | null;
  reportId?: string | null;
};

export type MeetingsPage = { items: InterviewSummary[]; nextCursor: string | null };
export type RecruiterTimelineEvent = {
  sequence: number; kind: string; message: string; occurredAt: string; integrityHash: string;
};
export type IntegrityReportSnapshot = {
  id: string; version: number; generatedAt: string;
  candidate: { name: string | null; email: string };
  interviewTitle: string; interviewer: string; scheduledStart: string; scheduledEnd: string;
  durationSeconds: number; consent: { status: string; version: string | null;
    acceptedAt: string | null };
  device: { platform: string | null; platformVersion: string | null; agentVersion: string | null };
  detectionResult: string; monitoringCoverage: number;
  interruptions: Array<{ startedAt: string; endedAt: string | null; reason: string }>;
  confirmedIncidents: Array<{ id: string; ruleKey: string; confidence: string;
    occurredAt: string; rulePackVersion: string }>;
  timeline: Array<{ kind: string; message: string; occurredAt: string; integrityHash: string }>;
  rulePackVersion: string; rulePackVersions?: string[]; disclaimer: string;
};
export type MeetingDetail = {
  interview: { id: string; title: string; candidateName: string | null; candidateEmail: string;
    interviewerEmail: string; scheduledStart: string; scheduledEnd: string; status: string;
    detectionResult: string | null; coveragePercentage: number | null; consentStatus: string };
  timeline: RecruiterTimelineEvent[]; report: IntegrityReportSnapshot | null;
};
export type WorkspaceNotification = { id: string; kind: string; title: string; message: string;
  severity: "INFO" | "WARNING" | "CRITICAL"; linkPath: string | null;
  readAt: string | null; createdAt: string };
export type BillingHistory = {
  transactions: Array<{ id: string; amount: number; kind: string; referenceId: string | null;
    createdAt: string }>;
  payments: Array<{ id: string; purpose: string; quantity: number; amountMinor: number | null;
    currency: string | null; createdAt: string }>;
};

export type AdminOrganization = {
  id: string; name: string; domain: string; status: string; subscriptionStatus: string | null;
  plan: string | null; calendarError: string | null; openDisputes: number;
  activeAgents: number; confirmedDetections: number;
};
export type AdminOverview = { organizations: AdminOrganization[];
  rulePacks: Array<{ platform: string; version: string; expiresAt: string; disabledAt: string | null }>;
  rules: Array<{ id: string; ruleKey: string; platform: string; version: number;
    confidence: string; status: string; enabled: boolean }>;
  applicationVersions: Array<{ application: string; platform: string; version: string;
    release_channel: string; source_commit_sha: string; artifact_digest: string }>;
  pendingChanges: Array<{ id: string; action: "DISABLE_RULE" | "REFUND_CREDITS";
    targetId: string; reason: string; requestedBy: string; payload: Record<string, unknown>;
    createdAt: string }>;
  disputes: Array<{ id: string; interviewId: string; reason: string; status: string;
    createdAt: string }> };
export type PilotReadiness = {
  ready: boolean; checkedAt: string; checks: Array<{ key: string; passed: boolean }>;
};

export type CommercialLead = { id: string; leadType: "DEMO_REQUEST" | "WAITLIST";
  fullName: string; email: string; companyName: string; stage: string;
  assignedTo: string | null; submissionCount: number; lastSubmittedAt: string;
  createdAt: string; updatedAt: string; convertedOrganizationId?: string | null;
  followUpOwner: string | null; followUpDueAt: string | null;
  followUpReminderAt: string | null; followUpCompletedAt: string | null };
export type PlatformStaffMember = { userId: string; name: string; email: string;
  role: "PLATFORM_FOUNDER" | "PLATFORM_SALES"; status: "ACTIVE" | "SUSPENDED" | "REMOVED" };
export type CommercialOverview = { role: "PLATFORM_FOUNDER" | "PLATFORM_SALES";
  staff: PlatformStaffMember[]; leads: CommercialLead[];
  nextCursor: string | null };
export type CommercialOrganization = { id: string; name: string; domain: string };
export type OrganizationMember = { userId: string; name: string; email: string;
  role: UserRole; status: "ACTIVE" | "SUSPENDED" | "REMOVED" };
export type OrganizationInvitation = { id: string; email: string; role: "MANAGER" | "HR";
  expiresAt: string; createdAt: string };
export type OrganizationMembersOverview = { organizationId: string; role: UserRole;
  members: OrganizationMember[]; invitations: OrganizationInvitation[] };
export type BillingGrant = { id: string; managerUserId: string; managerName: string;
  managerEmail: string; expiresAt: string | null; perPurchaseLimitMinor: number | null;
  monthlyLimitMinor: number | null; revokedAt: string | null };
export type BillingCapabilities = { role: UserRole; canPurchase: boolean;
  canManagePortal: boolean };
export type BillingCatalog = { currency: string; professionalAmountMinor: number;
  extraInterviewAmountMinor: number };
export type HrWallet = { memberUserId: string; name: string; email: string;
  available: number; reserved: number; consumed: number };
export type WalletsOverview = { role: UserRole; wallets: HrWallet[] };
export type EnterpriseAgreement = { id: string; leadId: string; organizationId: string;
  organizationName: string; state: string; contractValueMinor: number; currency: string;
  billingInterval: string; purchasedCredits: number; signedDocumentReference: string | null;
  invoiceTotalMinor: number; paymentTotalMinor: number };

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
