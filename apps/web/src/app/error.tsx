"use client";

import { RotateCcw } from "lucide-react";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="system-state">
      <span>Connection interrupted</span>
      <h1>Authenti8 could not load this page.</h1>
      <p>Your account data was not changed. Check the API connection and try again.</p>
      <button className="button-primary" onClick={reset} type="button"><RotateCcw size={17} /> Try again</button>
    </main>
  );
}
