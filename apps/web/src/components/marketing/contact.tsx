import { CalendarCheck2, Clock3, ShieldCheck } from "lucide-react";
import { Reveal } from "../reveal";
import { LeadForm } from "./lead-form";

export function ContactSection() {
  return <section className="section contact-section" id="contact">
    <div className="container contact-heading"><Reveal><span className="eyebrow">Early access</span>
      <h2 className="section-title">Bring evidence-backed integrity to your hiring process.</h2>
      <p className="section-copy">Authenti8 is onboarding selected hiring teams ahead of general
        availability. Speak with us about your workflow or reserve your place for launch.</p>
      <div className="contact-promises"><span><ShieldCheck size={17} />Private conversation</span>
        <span><Clock3 size={17} />Prompt follow-up</span><span><CalendarCheck2 size={17} />Tailored demo</span>
      </div></Reveal></div>
    <div className="container contact-grid">
      <Reveal className="lead-card" id="book-demo"><span>For active hiring teams</span>
        <h3>Book a private demo</h3><p>See the product and discuss coverage, deployment, and your
          interview volume with the Authenti8 team.</p><LeadForm leadType="DEMO_REQUEST" /></Reveal>
      <Reveal className="lead-card waitlist-card" id="waitlist"><span>For launch updates</span>
        <h3>Join the waitlist</h3><p>Receive considered product updates and an invitation when
          Authenti8 opens access more broadly.</p><LeadForm leadType="WAITLIST" /></Reveal>
    </div>
  </section>;
}
