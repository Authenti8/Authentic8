import { Capabilities } from "@/components/marketing/capabilities";
import { ContactSection } from "@/components/marketing/contact";
import { Faq } from "@/components/marketing/faq";
import { MarketingFooter } from "@/components/marketing/footer";
import { MarketingHeader } from "@/components/marketing/header";
import { Hero } from "@/components/marketing/hero";
import { Privacy } from "@/components/marketing/privacy";
import { Problem } from "@/components/marketing/problem";
import { TrustStrip } from "@/components/marketing/trust-strip";

export default function HomePage() {
  return (
    <main>
      <MarketingHeader />
      <Hero />
      <TrustStrip />
      <Problem />
      <Capabilities />
      <Privacy />
      <ContactSection />
      <Faq />
      <MarketingFooter />
    </main>
  );
}
