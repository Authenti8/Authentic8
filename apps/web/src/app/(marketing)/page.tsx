import { Capabilities } from "@/components/marketing/capabilities";
import { Faq } from "@/components/marketing/faq";
import { MarketingFooter } from "@/components/marketing/footer";
import { MarketingHeader } from "@/components/marketing/header";
import { Hero } from "@/components/marketing/hero";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { Pricing } from "@/components/marketing/pricing";
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
      <HowItWorks />
      <Capabilities />
      <Privacy />
      <Pricing />
      <Faq />
      <MarketingFooter />
    </main>
  );
}
