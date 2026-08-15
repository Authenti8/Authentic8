"use client";

import { Printer } from "lucide-react";

export function PrintReportButton() {
  return <button className="button-secondary print-report" onClick={() => window.print()}>
    <Printer size={15} /> Print or save PDF</button>;
}
