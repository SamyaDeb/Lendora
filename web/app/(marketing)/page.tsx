import Hero from "@/components/landing/Hero";
import Opportunity from "@/components/landing/Opportunity";
import MarketsPreview from "@/components/landing/MarketsPreview";
import Community from "@/components/landing/Community";
import Articles from "@/components/landing/Articles";
import Subscribe from "@/components/landing/Subscribe";
import Earn from "@/components/landing/Earn";
import {FEATURES} from "@/lib/features";
import {vaultSource} from "@/lib/vault";
import LandingFooter from "@/components/landing/LandingFooter";

/** The vault's 30-day net APY from the adapter, only while the vault flag is on (never blocks the page for long). */
async function earnApy(): Promise<number | undefined> {
  if (!FEATURES.vault) return undefined;
  const timeout = new Promise<undefined>((r) => setTimeout(() => r(undefined), 1500));
  return Promise.race([vaultSource().overview().then((o) => o.apy.d30), timeout]).catch(() => undefined);
}

export default async function LandingPage() {
  const apy = await earnApy();
  return (
    <>
      <Hero />
      <Opportunity />
      <MarketsPreview />
      <Earn apy={apy} />
      <Community />
      <Articles />
      <Subscribe />
      <LandingFooter />
    </>
  );
}
