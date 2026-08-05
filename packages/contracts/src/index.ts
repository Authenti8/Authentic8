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
