import { Reveal } from "../reveal";

const questions = [
  ["Does Authenti8 detect every kind of cheating?", "No. Authenti8 identifies active use of specifically supported and validated tool versions. Phones, secondary computers, unknown tools, and activity outside the monitored window are not covered."],
  ["Does it judge eye movement or nervousness?", "Never. Authenti8 does not use gaze, facial expression, accent, pauses, or answer quality as evidence."],
  ["What does Not Detected mean?", "It means no supported tool met the confirmation threshold during the verified monitoring window. It is not proof that cheating was impossible."],
  ["Can a candidate decline?", "Yes. Monitoring starts only after explicit consent. Declining is reported as consent declined and is never converted into a cheating result."],
  ["Does the Google Meet link change?", "No. The product is designed to preserve the original Google Meet workflow and associate protection with the interview session."],
] as const;

export function Faq() {
  return (
    <section className="section faq-section" id="faq">
      <div className="container faq-layout">
        <Reveal><span className="eyebrow">Straight answers</span><h2 className="section-title">What responsible detection means.</h2></Reveal>
        <Reveal className="faq-list">
          {questions.map(([question, answer]) => <details key={question}><summary>{question}<span>+</span></summary><p>{answer}</p></details>)}
        </Reveal>
      </div>
    </section>
  );
}
