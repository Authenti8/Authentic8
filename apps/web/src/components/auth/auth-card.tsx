import Link from "next/link";
import type { ReactNode } from "react";

export function AuthCard({
  eyebrow,
  title,
  copy,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="auth-card">
      <span className="auth-eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p className="auth-copy">{copy}</p>
      {children}
      {footer && <div className="auth-footer">{footer}</div>}
      <Link className="back-home" href="/">← Back to Authenti8</Link>
    </div>
  );
}
