import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OrganizationForm } from "@/components/onboarding/organization-form";
import { requireSession } from "@/lib/server-api";
import "./onboarding.css";

export const metadata: Metadata = { title: "Set up your organization" };

export default async function OnboardingPage() {
  const session = await requireSession();
  if (session.organization) redirect("/dashboard");
  return (
    <main className="onboarding-page">
      <section className="onboarding-card">
        <div className="onboarding-progress"><span>Account</span><i /><strong>Organization</strong><i /><span>Pilot</span></div>
        <span className="auth-eyebrow">Organization setup</span>
        <h1>Create your hiring workspace</h1>
        <p>These details scope your workspace, default policy, and pilot onboarding. You can update operational settings later.</p>
        <OrganizationForm />
      </section>
      <aside className="onboarding-aside"><span>What happens next</span><h2>We review your pilot with you.</h2><ol><li>Choose a limited pilot scope</li><li>Run a recruiter preflight</li><li>Prepare candidate disclosure</li><li>Support the interview live</li></ol></aside>
    </main>
  );
}
