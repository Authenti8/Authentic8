"use client";

import type { OnboardingResponse } from "@authenti8/contracts";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { Field, FormMessage, SelectField, SubmitButton } from "../auth/form-controls";
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
      <OrganizationIdentity />
      <OrganizationProfile />
      <FormMessage error={mutation.error} message="" />
      <SubmitButton pending={mutation.pending} label="Create organization workspace" />
      <p className="onboarding-note">You will become the workspace owner. A strict evidence policy is enabled by default.</p>
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
    <>
      <div className="form-grid">
        <SelectField defaultValue="" label="Your role" name="jobRole" required><option disabled value="">Select role</option>{roles.map((role) => <option key={role}>{role}</option>)}</SelectField>
        <SelectField defaultValue="" label="Company size" name="companySize" required><option disabled value="">Select size</option>{sizes.map((size) => <option key={size}>{size}</option>)}</SelectField>
      </div>
      <div className="form-grid">
        <Field label="Monthly interviews" min={0} name="expectedMonthlyInterviews" placeholder="20" required type="number" />
        <SelectField defaultValue="Asia/Kolkata" label="Default timezone" name="timezone" required>{timezones.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</SelectField>
      </div>
    </>
  );
}

const roles = ["Founder", "Hiring manager", "Recruiter", "People leader", "Other"];
const sizes = ["1-10", "11-50", "51-200", "201-1000", "1000+"];
const timezones = [
  ["Asia/Kolkata", "India · Asia/Kolkata"],
  ["America/Los_Angeles", "Pacific Time"],
  ["America/Denver", "Mountain Time"],
  ["America/Chicago", "Central Time"],
  ["America/New_York", "Eastern Time"],
  ["Europe/London", "London"],
  ["Europe/Berlin", "Central Europe"],
  ["Asia/Singapore", "Singapore"],
  ["Australia/Sydney", "Sydney"],
] as const;
