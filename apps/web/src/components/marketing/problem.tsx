import { Bot, ScanSearch, ShieldAlert } from "lucide-react";
import { Reveal } from "../reveal";

const cards = [
  { icon: Bot, title: "Invisible assistance is real", text: "Real-time interview tools can listen, transcribe, and surface suggested answers without appearing in a normal screen share." },
  { icon: ShieldAlert, title: "Suspicion is not evidence", text: "Gaze, pauses, nerves, and tab changes are unreliable. Hiring teams need a technical standard they can explain." },
  { icon: ScanSearch, title: "Coverage must be honest", text: "A clean result only means something when the platform, tool version, consent, and verified monitoring window are clear." },
] as const;

export function Problem() {
  return (
    <section className="section problem-section">
      <div className="container">
        <Reveal>
          <span className="eyebrow">The new interview risk</span>
          <h2 className="section-title">Trust should not depend on reading body language.</h2>
          <p className="section-copy">Authenti8 replaces behavioral suspicion with a narrow, evidence-backed integrity check for specifically supported tools.</p>
        </Reveal>
        <div className="problem-grid">
          {cards.map(({ icon: Icon, title, text }) => (
            <Reveal className="problem-card" key={title}>
              <Icon size={25} /><h3>{title}</h3><p>{text}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
