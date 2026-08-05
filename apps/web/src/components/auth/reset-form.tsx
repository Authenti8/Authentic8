"use client";

import type { AuthResponse } from "@authenti8/contracts";
import Link from "next/link";
import type { FormEvent } from "react";
import { Field, FormMessage, SubmitButton } from "./form-controls";
import { useApiMutation } from "./use-api-mutation";

export function ResetForm({ token }: { token: string }) {
  const mutation = useApiMutation<AuthResponse>("/auth/reset-password");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await mutation.mutate({ token, password: values.get("password") });
  }
  if (mutation.data) return <div className="auth-success"><span>✓</span><h2>Password updated</h2><p>{mutation.data.message}</p><Link href="/login">Continue to login</Link></div>;
  return (
    <form className="auth-form" onSubmit={submit}>
      <Field autoComplete="new-password" label="New password" minLength={12} name="password" required type="password" />
      <p className="field-hint">12+ characters with uppercase, lowercase, number, and symbol.</p>
      <FormMessage error={mutation.error} message="" />
      <SubmitButton pending={mutation.pending} label="Update password" />
    </form>
  );
}
