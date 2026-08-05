import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_ORIGIN ?? "http://localhost:3000"),
  title: {
    default: "Authenti8 — Evidence-backed interview integrity",
    template: "%s · Authenti8",
  },
  description:
    "Protect live interviews with consent-based, evidence-backed detection for supported real-time AI assistance tools.",
  openGraph: {
    title: "Authenti8 — Interview integrity, backed by evidence",
    description:
      "Private live status and reproducible reports for consented Google Meet interviews.",
    images: ["/hero-office.png"],
  },
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body>{children}</body>
    </html>
  );
}
