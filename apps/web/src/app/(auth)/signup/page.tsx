import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/auth-card";
import { SignupForm } from "@/components/auth/signup-form";

export const metadata: Metadata = { title: "Pilot access" };

export default function SignupPage() {
  return (
    <AuthCard eyebrow="Design-partner access" title="Start your Authenti8 workspace" copy="Tell us who you are. Organization setup comes next." footer={<p>Already have an account? <Link href="/login">Log in</Link></p>}>
      <SignupForm />
    </AuthCard>
  );
}
