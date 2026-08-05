import Link from "next/link";
import { Brand } from "../brand";

export function MarketingFooter() {
  return (
    <footer className="marketing-footer">
      <div className="container footer-top">
        <div><Brand /><p>Evidence-backed integrity for live interviews.</p></div>
        <div className="footer-links"><a href="#how">How it works</a><a href="#privacy">Privacy</a><Link href="/login">Log in</Link><Link href="/signup">Pilot access</Link></div>
      </div>
      <div className="container footer-bottom"><span>© {new Date().getFullYear()} Authenti8</span><span>Google Meet pilot · Windows 11</span></div>
    </footer>
  );
}
