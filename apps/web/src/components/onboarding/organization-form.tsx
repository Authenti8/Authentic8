"use client";

import type { OnboardingResponse } from "@authenti8/contracts";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { Field, FormMessage, SelectField } from "../auth/form-controls";
import { useApiMutation } from "../auth/use-api-mutation";

export function OrganizationForm() {
  const router = useRouter();
  const mutation = useApiMutation<OnboardingResponse>("/organizations");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const result = await mutation.mutate(values);
    if (result) router.replace(result.next);
  }
  return (
    <form className="onboarding-form" onSubmit={submit}>
      <FormSection label="Company details" number="01" />
      <OrganizationIdentity />
      <FormSection label="Your team" number="02" />
      <OrganizationProfile />
      <FormMessage error={mutation.error} message="" />
      <button className="onboarding-submit" disabled={mutation.pending} type="submit">
        <span>{mutation.pending ? "Creating your workspace…" : "Create workspace"}</span>
        {!mutation.pending && <ArrowRight aria-hidden size={17} />}
      </button>
      <p className="onboarding-note"><LockKeyhole aria-hidden size={13} /> You will be the workspace owner. Evidence controls are enabled by default.</p>
    </form>
  );
}

function OrganizationIdentity() {
  return (
    <div className="form-grid">
      <Field autoComplete="organization" label="Organization name" name="name" placeholder="Acme Labs" required />
      <Field autoCapitalize="none" label="Company domain" name="domain" placeholder="acme.com" required />
    </div>
  );
}

function OrganizationProfile() {
  return (
    <div className="form-grid">
      <SelectField defaultValue="" label="Your role" name="jobRole" required><option disabled value="">Select your role</option>{roles.map((role) => <option key={role}>{role}</option>)}</SelectField>
      <SelectField defaultValue="" label="Company size" name="companySize" required><option disabled value="">Select company size</option>{sizes.map((size) => <option key={size}>{size}</option>)}</SelectField>
    </div>
  );
}

function FormSection({ label, number }: { label: string; number: string }) {
  return <div className="form-section-label"><span>{number}</span><strong>{label}</strong><i /></div>;
}

const roles = ["Founder", "Hiring manager", "Recruiter", "People leader", "Other"];
const sizes = ["1-10", "11-50", "51-200", "201-1000", "1000+"];
