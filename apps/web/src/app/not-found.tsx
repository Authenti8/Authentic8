import Link from "next/link";

export default function NotFound() {
  return (
    <main className="system-state">
      <span>404</span><h1>This page is outside the interview window.</h1>
      <p>The address may have changed or the link may be incomplete.</p>
      <Link className="button-primary" href="/">Return home</Link>
    </main>
  );
}
