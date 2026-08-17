import { Brand } from "../brand";

export function MarketingHeader() {
  return (
    <header className="marketing-header">
      <div className="container nav-inner">
        <Brand />
        <nav aria-label="Primary navigation">
          <a href="#capabilities">Product</a>
          <a href="#privacy">Privacy</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className="nav-actions">
          <a href="#waitlist">Join waitlist</a>
          <a className="button-primary nav-cta" href="#book-demo">Book a demo</a>
        </div>
      </div>
    </header>
  );
}
