import { CalendarCheck2, FileClock, Laptop2, RadioTower } from "lucide-react";
import { Reveal } from "../reveal";

const steps = [
  [CalendarCheck2, "01", "Keep the original Meet", "Schedule the interview as usual. Authenti8 protects the session without replacing the meeting provider."],
  [Laptop2, "02", "Candidate consents", "The candidate sees what will be checked, chooses whether to continue, and enrolls one device for one interview."],
  [RadioTower, "03", "Verify during the session", "Technical identity, active use, monitoring health, and interruptions are evaluated inside the authorized window."],
  [FileClock, "04", "Review the evidence", "The recruiter sees private live status and receives a reproducible report with coverage and limitations."],
] as const;

export function HowItWorks() {
  return (
    <section className="section how-section" id="how">
      <div className="container">
        <Reveal className="how-heading">
          <span className="eyebrow">How Authenti8 works</span>
          <h2 className="section-title">Your interview stays familiar. The integrity layer works around it.</h2>
        </Reveal>
        <div className="steps-grid">
          {steps.map(([Icon, number, title, text]) => (
            <Reveal className="step-card" key={number}>
              <div className="step-top"><Icon size={24} /><span>{number}</span></div>
              <h3>{title}</h3><p>{text}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
