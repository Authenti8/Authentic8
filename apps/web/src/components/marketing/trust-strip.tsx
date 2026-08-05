import { EyeOff, FileCheck2, ShieldCheck, UserCheck } from "lucide-react";

const items = [
  [UserCheck, "Explicit consent"],
  [ShieldCheck, "Technical evidence"],
  [EyeOff, "No gaze tracking"],
  [FileCheck2, "Auditable reports"],
] as const;

export function TrustStrip() {
  return (
    <section className="trust-strip" aria-label="Authenti8 principles">
      <div className="container trust-grid">
        {items.map(([Icon, label]) => <div key={label}><Icon size={19} /><span>{label}</span></div>)}
      </div>
    </section>
  );
}
