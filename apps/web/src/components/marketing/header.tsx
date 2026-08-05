import { cookies } from "next/headers";
import Link from "next/link";
import { Brand } from "../brand";

export async function MarketingHeader() {
  const authenticated = (await cookies()).has("authenti8_session");
  return (
    <header className="marketing-header">
      <div className="container nav-inner">
        <Brand />
        <nav aria-label="Primary navigation">
          <a href="#how">How it works</a>
          <a href="#privacy">Privacy</a>
          <a href="#pricing">Pilot</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className="nav-actions">
          {!authenticated && <Link href="/login">Log in</Link>}
          <Link className="button-primary nav-cta" href={authenticated ? "/dashboard" : "/signup"}>
            {authenticated ? "Open dashboard" : "Run a pilot"}
          </Link>
        </div>
      </div>
    </header>
  );
}
