"use client";

import type { AuthResponse } from "@authenti8/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { Field, FormMessage, SubmitButton } from "./form-controls";
import { useApiMutation } from "./use-api-mutation";

export function LoginForm({ nextPath }: { nextPath?: string }) {
  const router = useRouter();
  const mutation = useApiMutation<AuthResponse>("/auth/login");
  const googleHref = nextPath
    ? `/api/v1/auth/google?next=${encodeURIComponent(nextPath)}`
    : "/api/v1/auth/google";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const result = await mutation.mutate({ email: values.get("email"), password: values.get("password") });
    if (result) router.replace(nextPath ?? result.next ?? "/dashboard");
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <a className="google-button" href={googleHref}><GoogleMark /> Continue with Google</a>
      <div className="form-divider"><span>or use work email</span></div>
      <Field autoComplete="email" label="Work email" name="email" placeholder="you@company.com" required type="email" />
      <Field autoComplete="current-password" label="Password" name="password" required type="password" />
      <div className="form-row"><span /><Link href="/forgot-password">Forgot password?</Link></div>
      <FormMessage error={mutation.error} message="" />
      <SubmitButton pending={mutation.pending} label="Log in" />
    </form>
  );
}

function GoogleMark() {
  return <span className="google-mark" aria-hidden="true">G</span>;
}
