import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { ResetForm } from "@/components/auth/reset-form";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const { token = "" } = await searchParams;
  return <AuthCard eyebrow="Secure your account" title="Choose a new password" copy="This link is single-use and expires after one hour."><ResetForm token={String(token)} /></AuthCard>;
}
