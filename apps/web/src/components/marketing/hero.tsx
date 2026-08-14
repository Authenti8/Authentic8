import { ArrowRight, Check, Radio, ShieldAlert } from "lucide-react";
import Link from "next/link";

export function Hero() {
  return (
    <section className="hero">
      <div className="container hero-content">
        <div className="hero-product" aria-label="Authenti8 monitoring a Google Meet interview">
          <div className="hero-product-bar" aria-hidden="true">
            <span className="hero-window-dots"><i /><i /><i /></span>
            <span>Google Meet · Interview in progress</span>
            <b><i /> Protected by Authenti8</b>
          </div>
          <video
            className="hero-meet-image"
            width={1672}
            height={941}
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            aria-hidden="true"
          >
            <source src="/google_meet.mp4" type="video/mp4" />
          </video>
          <IntegrityLog />
        </div>

        <div className="hero-copy">
          <div className="pilot-pill"><Radio size={14} /> Live interview integrity</div>
          <h1>Know when an interview stops being <span>authentic.</span></h1>
          <p>
            Authenti8 monitors consented interviews and turns device activity into a
            clear integrity timeline—flagging cheating tools as they appear.
          </p>
          <div className="hero-actions">
            <Link className="button-primary" href="/signup">
              Protect an interview <ArrowRight size={17} />
            </Link>
            <a className="button-secondary" href="#how">See how it works</a>
          </div>
        </div>
      </div>
    </section>
  );
}

function IntegrityLog() {
  return (
    <aside className="integrity-log" aria-label="Example live integrity log">
      <div className="integrity-log-list">
        <LogItem delay="0.35s" time="09:00" text="Candidate joined the meeting" />
        <LogItem delay="0.85s" time="09:01" text="Candidate identity verified" />
        <LogItem delay="1.35s" time="09:02" text="Candidate approved consent" />
        <LogItem delay="1.85s" time="09:03" text="Device monitoring active" />
        <LogItem delay="2.35s" time="09:04" text="Interview monitoring healthy" />
        <LogItem delay="3.05s" time="09:22" text="Cheating tool detected" alert />
      </div>
    </aside>
  );
}

function LogItem({
  alert = false,
  delay,
  text,
  time,
}: {
  alert?: boolean;
  delay: string;
  text: string;
  time: string;
}) {
  return (
    <div className={`integrity-log-item${alert ? " is-alert" : ""}`} style={{ animationDelay: delay }}>
      <span className="integrity-log-icon" aria-hidden="true">
        {alert ? <ShieldAlert size={15} /> : <Check size={15} />}
      </span>
      <div><strong>{text}</strong><time>{time}</time></div>
    </div>
  );
}
