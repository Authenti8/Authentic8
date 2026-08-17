import { BellRing, Clock3, ShieldCheck } from "lucide-react";
import { Reveal } from "../reveal";
import { LeadForm } from "./lead-form";

export function ContactSection() {
  return <section className="section contact-section" id="contact">
    <div className="container contact-heading"><Reveal><span className="eyebrow">Early access</span>
      <h2 className="section-title">Bring evidence-backed integrity to your hiring process.</h2>
      <p className="section-copy">Authenti8 is onboarding selected hiring teams ahead of general
        availability. Reserve your organization&apos;s place for launch.</p>
      <div className="contact-promises"><span><ShieldCheck size={17} />Private submission</span>
        <span><Clock3 size={17} />Prompt follow-up</span><span><BellRing size={17} />Launch updates</span>
      </div></Reveal></div>
    <div className="container contact-grid waitlist-only">
      <Reveal className="lead-card waitlist-card" id="waitlist"><span>For launch updates</span>
        <h3>Join the waitlist</h3><p>Receive considered product updates and an invitation when
          Authenti8 opens access more broadly.</p><LeadForm /></Reveal>
    </div>
  </section>;
}
