import Hero from "@/components/landing/Hero";
import Opportunity from "@/components/landing/Opportunity";
import MarketsPreview from "@/components/landing/MarketsPreview";
import Community from "@/components/landing/Community";
import Articles from "@/components/landing/Articles";
import Subscribe from "@/components/landing/Subscribe";
import Earn from "@/components/landing/Earn";
import LandingFooter from "@/components/landing/LandingFooter";
import {FEATURES} from "@/lib/features";
import {vaultSource} from "@/lib/vault";
import {safe, serverApi, type Market} from "@/lib/api";
import {TICKERS} from "@/lib/env";

/** Resolves to undefined after `ms`, so a slow data source never holds the landing page. */
const within = <T,>(p: Promise<T | undefined>, ms = 1500) => Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]).catch(() => undefined);

/** The vault's 30-day net APY from the adapter, only while the vault flag is on. */
async function earnApy(): Promise<number | undefined> {
  if (!FEATURES.vault) return undefined;
  return within(vaultSource().overview().then((o) => o.apy.d30 ?? undefined));
}

/**
 * The marketing landing. Every number on it is live from the public API (markets) or the vault adapter; when a
 * source doesn't answer, the sections show the product without numbers rather than placeholders (CP-R7).
 */
export default async function LandingPage() {
  const [apy, res] = await Promise.all([earnApy(), within(safe(serverApi().markets()))]);
  const markets: Market[] | undefined = res?.data;
  return (
    <>
      <Hero markets={markets} tickers={TICKERS} />
      <Opportunity vault={FEATURES.vault} />
      <MarketsPreview markets={markets} tickers={TICKERS} asOfBlock={res?.asOfBlock} />
      <Earn apy={apy} />
      <Community />
      <Articles />
      <Subscribe />
      <LandingFooter />
    </>
  );
}
