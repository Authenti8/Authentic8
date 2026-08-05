import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { VerifyAction } from "@/components/auth/verify-action";

export const metadata: Metadata = { title: "Verify email" };

export default async function VerifyEmailPage({ searchParams }: PageProps<"/verify-email">) {
  const { token = "" } = await searchParams;
  return <AuthCard eyebrow="One quick check" title="Verify your work email" copy="Verification links are single-use and expire after 24 hours."><VerifyAction token={String(token)} /></AuthCard>;
}
