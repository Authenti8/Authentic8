import { Activity, Blocks, FileLock2, ScanLine } from "lucide-react";
import { Reveal } from "../reveal";

const capabilities = [
  [ScanLine, "Named-tool verification", "Authenti8 confirms only tested technical identities—not generic AI behavior."],
  [Activity, "Active-use evidence", "Installed but closed is different from active during the authorized interview."],
  [Blocks, "Monitoring integrity", "Agent health, permissions, and interruptions stay separate from the detection result."],
  [FileLock2, "Evidence chain", "Ordered, signed evidence supports the live status and final report."],
] as const;

export function Capabilities() {
  return (
    <section className="section capabilities-section">
      <div className="container capabilities-layout">
        <Reveal>
          <span className="eyebrow">A higher standard</span>
          <h2 className="section-title">Confirm less. Mean more.</h2>
          <p className="section-copy">A confirmed result requires supported tool identity, active use during the interview, and valid evidence. Everything else remains unconfirmed.</p>
        </Reveal>
        <div className="capability-list">
          {capabilities.map(([Icon, title, text]) => (
            <Reveal className="capability-item" key={title}>
              <Icon size={22} /><div><h3>{title}</h3><p>{text}</p></div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
