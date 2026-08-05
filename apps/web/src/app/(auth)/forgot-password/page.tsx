import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/auth-card";
import { ForgotForm } from "@/components/auth/forgot-form";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return <AuthCard eyebrow="Account recovery" title="Reset your password" copy="We will send a short-lived reset link if the account exists." footer={<p>Remembered it? <Link href="/login">Back to login</Link></p>}><ForgotForm /></AuthCard>;
}
