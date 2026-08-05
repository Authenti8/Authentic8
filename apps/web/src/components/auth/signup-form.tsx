"use client";

import type { AuthResponse } from "@authenti8/contracts";
import type { FormEvent } from "react";
import { Field, FormMessage, SubmitButton } from "./form-controls";
import { useApiMutation } from "./use-api-mutation";

export function SignupForm() {
  const mutation = useApiMutation<AuthResponse>("/auth/signup");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await mutation.mutate({ fullName: values.get("fullName"), email: values.get("email"), password: values.get("password") });
  }

  if (mutation.data) return <SignupSuccess response={mutation.data} />;
  return (
    <form className="auth-form" onSubmit={submit}>
      {/* OAuth must perform a full document navigation to follow the provider redirect. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a className="google-button" href="/api/v1/auth/google"><span className="google-mark">G</span> Continue with Google</a>
      <div className="form-divider"><span>or use work email</span></div>
      <Field autoComplete="name" label="Full name" name="fullName" placeholder="Rahul Panchal" required />
      <Field autoComplete="email" label="Work email" name="email" placeholder="you@company.com" required type="email" />
      <Field autoComplete="new-password" label="Password" minLength={12} name="password" required type="password" />
      <p className="field-hint">12+ characters with uppercase, lowercase, number, and symbol.</p>
      <FormMessage error={mutation.error} message="" />
      <SubmitButton pending={mutation.pending} label="Create workspace account" />
      <p className="legal-copy">By continuing, you agree to use Authenti8 only with candidate disclosure and consent.</p>
    </form>
  );
}

function SignupSuccess({ response }: { response: AuthResponse }) {
  return (
    <div className="auth-success">
      <span>✓</span><h2>Check your inbox</h2><p>{response.message}</p>
      {response.previewUrl && <a href={response.previewUrl}>Development preview: verify email</a>}
    </div>
  );
}
