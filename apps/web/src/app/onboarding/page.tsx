import type { Metadata } from "next";
import { Check, ShieldCheck, Sparkles } from "lucide-react";
import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { OrganizationForm } from "@/components/onboarding/organization-form";
import { requireSession } from "@/lib/server-api";
import "./onboarding.css";

export const metadata: Metadata = { title: "Set up your organization" };

export default async function OnboardingPage() {
  const session = await requireSession();
  if (session.organization) redirect("/dashboard");
  return (
    <main className="onboarding-page">
      <section className="onboarding-stage">
        <header className="onboarding-brand"><Brand /><span><i /> Secure setup</span></header>
        <div className="onboarding-card">
          <div className="onboarding-progress"><span className="complete"><Check size={11} /> Account</span><i /><strong>02&nbsp; Workspace</strong><i /><span>03&nbsp; Pilot</span></div>
          <span className="auth-eyebrow">Workspace setup</span>
          <h1>Tell us about your hiring team.</h1>
          <p>We’ll use this to prepare a focused pilot workspace for your organization. It takes less than a minute.</p>
          <OrganizationForm />
        </div>
      </section>
      <OnboardingAside />
    </main>
  );
}

function OnboardingAside() {
  return (
    <aside className="onboarding-aside">
      <div className="aside-glow" />
      <div className="aside-top"><Sparkles size={15} /><span>White-glove pilot onboarding</span></div>
      <div className="aside-copy"><span>What happens next</span><h2>A guided path to your first protected interview.</h2><p>We help your team define the pilot, prepare the workflow, and enter the first session with confidence.</p></div>
      <ol><li><strong>Scope the pilot</strong><small>Align on roles, interview format, and success criteria.</small></li><li><strong>Prepare your team</strong><small>Complete a recruiter preflight before candidate day.</small></li><li><strong>Launch with support</strong><small>Run your first interview with Authenti8 alongside you.</small></li></ol>
      <div className="aside-trust"><ShieldCheck size={18} /><span><strong>Evidence controls included</strong><small>Private by design. Clear by default.</small></span></div>
    </aside>
  );
}
