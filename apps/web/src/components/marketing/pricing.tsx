import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import { Reveal } from "../reveal";

const included = ["White-glove setup", "Windows 11 pilot", "Google Meet workflow", "Private live status", "Integrity report", "Direct founder support"];

export function Pricing() {
  return (
    <section className="section pricing-section" id="pricing">
      <div className="container pricing-layout">
        <Reveal>
          <span className="eyebrow">Design-partner pilot</span>
          <h2 className="section-title">Run the workflow with us before you buy software.</h2>
          <p className="section-copy">We are onboarding a small group of founders and hiring teams for supervised pilot interviews. Coverage is limited to the tools, versions, and operating systems we have validated.</p>
        </Reveal>
        <Reveal className="pilot-plan">
          <span className="plan-label">Pilot access</span>
          <h3>Built with your hiring team</h3>
          <p>No self-serve checkout. We scope every pilot honestly and support it live.</p>
          <div className="included-list">{included.map((item) => <span key={item}><Check size={16} />{item}</span>)}</div>
          <Link className="button-primary" href="/signup">Request pilot access <ArrowRight size={17} /></Link>
        </Reveal>
      </div>
    </section>
  );
}
