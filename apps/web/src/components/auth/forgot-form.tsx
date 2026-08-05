"use client";

import type { AuthResponse } from "@authenti8/contracts";
import type { FormEvent } from "react";
import { Field, FormMessage, SubmitButton } from "./form-controls";
import { useApiMutation } from "./use-api-mutation";

export function ForgotForm() {
  const mutation = useApiMutation<AuthResponse>("/auth/forgot-password");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await mutation.mutate({ email: values.get("email") });
  }
  return (
    <form className="auth-form" onSubmit={submit}>
      <Field autoComplete="email" label="Work email" name="email" placeholder="you@company.com" required type="email" />
      <FormMessage error={mutation.error} message={mutation.data?.message ?? ""} />
      {mutation.data?.previewUrl && <a className="preview-link" href={mutation.data.previewUrl}>Development preview: reset password</a>}
      <SubmitButton pending={mutation.pending} label="Send reset link" />
    </form>
  );
}
