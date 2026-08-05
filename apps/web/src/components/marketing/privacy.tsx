import { Check, LockKeyhole } from "lucide-react";
import { Reveal } from "../reveal";

const promises = [
  "No monitoring before explicit consent",
  "No eye tracking or emotion scoring",
  "No access to personal files or messages",
  "No raw screen or audio upload in the pilot design",
  "Monitoring stops when the authorized session ends",
  "A declined check is never labelled as cheating",
];

export function Privacy() {
  return (
    <section className="section privacy-section" id="privacy">
      <div className="container privacy-card">
        <Reveal className="privacy-copy">
          <span className="privacy-icon"><LockKeyhole size={27} /></span>
          <span className="eyebrow">Privacy by boundary</span>
          <h2 className="section-title">Check what matters. Leave everything else alone.</h2>
          <p className="section-copy">Authenti8 is designed as a temporary, consented integrity check—not continuous employee monitoring.</p>
        </Reveal>
        <Reveal className="promise-list">
          {promises.map((promise) => <div key={promise}><Check size={18} /><span>{promise}</span></div>)}
        </Reveal>
      </div>
    </section>
  );
}
