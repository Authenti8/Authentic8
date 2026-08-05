"use client";

import type { AuthResponse } from "@authenti8/contracts";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { Field, FormMessage, SubmitButton } from "./form-controls";
import { useApiMutation } from "./use-api-mutation";

export function VerifyAction({ token }: { token: string }) {
  const router = useRouter();
  const mutation = useApiMutation<AuthResponse>("/auth/verify-email");
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const result = await mutation.mutate({ token, password: values.get("password") });
    if (result) router.replace(result.next ?? "/onboarding");
  }
  return (
    <form className="auth-form" onSubmit={verify}>
      <Field
        autoComplete="current-password"
        label="Confirm your signup password"
        minLength={12}
        name="password"
        required
        type="password"
      />
      <p className="field-hint">This confirms the email belongs to the same signup attempt.</p>
      <FormMessage error={mutation.error} message="" />
      <SubmitButton pending={!token || mutation.pending} label="Verify email and continue" />
      {!token && <p className="form-message error">This verification link is incomplete.</p>}
    </form>
  );
}
