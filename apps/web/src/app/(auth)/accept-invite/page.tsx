import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/auth-card";
import { getSession } from "@/lib/server-api";
import { acceptInvitation } from "./actions";

export const metadata: Metadata = { title: "Accept organization invitation" };

export default async function AcceptInvitePage({ searchParams }: PageProps<"/accept-invite">) {
  const raw = (await searchParams).token;
  const token = typeof raw === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(raw) ? raw : "";
  const session = await getSession();
  return <AuthCard eyebrow="Organization invitation" title="Join your hiring team"
    copy="Invitations are private, email-bound, and expire after 72 hours."
    footer={<p>Need help? Contact the person who invited you for a new link.</p>}>
    {!token ? <p className="auth-message error">This invitation link is invalid.</p>
      : session ? <form className="auth-form" action={acceptInvitation}>
        <input type="hidden" name="token" value={token} /><p className="auth-message">
          Continue as <strong>{session.user.email}</strong>.</p>
        <button className="submit-button" type="submit">Accept invitation</button></form>
      : <div className="auth-form"><p className="auth-message">Log in with the invited email
        address, then this invitation will continue automatically.</p>
        <Link className="submit-button" href={`/login?next=${encodeURIComponent(
          `/accept-invite?token=${token}`)}`}>Log in to accept</Link>
        <p className="auth-message">New to Authenti8? <Link href="/signup">Create an account</Link>,
          verify the invited email, then reopen this invitation.</p></div>}
  </AuthCard>;
}
