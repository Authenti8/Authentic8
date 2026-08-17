import { Brand } from "../brand";

export function MarketingFooter() {
  return (
    <footer className="marketing-footer">
      <div className="container footer-top">
        <div><Brand /><p>Evidence-backed integrity for live interviews.</p></div>
        <div className="footer-links"><a href="#capabilities">Product</a><a href="#privacy">Privacy</a>
          <a href="#waitlist">Join waitlist</a></div>
      </div>
      <div className="container footer-bottom"><span>© {new Date().getFullYear()} Authenti8</span>
        <span>Consent-based interview integrity</span></div>
    </footer>
  );
}
