import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  return (
    <AuthCard eyebrow="Welcome back" title="Log in to Authenti8" copy="Open your hiring workspace and protected interview history." footer={<p>New to Authenti8? <Link href="/signup">Request pilot access</Link></p>}>
      <LoginForm nextPath={safeProtectedPath(next)} />
    </AuthCard>
  );
}

function safeProtectedPath(value: string | string[] | undefined) {
  const path = Array.isArray(value) ? value[0] : value;
  if (!path) return undefined;
  const allowed = ["/dashboard", "/onboarding", "/accept-invite"];
  return allowed.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    ? path
    : undefined;
}
