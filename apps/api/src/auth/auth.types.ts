export type AuthenticatedRequest = {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  session?: {
    id: string;
    tokenHash: string;
    userId: string;
  };
};

export type SessionToken = {
  rawToken: string;
  expiresAt: Date;
};

export type UserRow = {
  id: string;
  email: string;
  normalized_email: string;
  full_name: string;
  password_hash: string | null;
  email_verified_at: Date | null;
  status: string;
};
