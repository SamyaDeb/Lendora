import {safe, serverApi} from "@/lib/api";
import {TICKERS} from "@/lib/env";
import {DataScreen} from "@/components/data/DataScreen";

export const metadata = {title: "Short interest", description: "Live short interest for Stock Tokens on Robinhood Chain: borrowed shares, % of float, borrow rates, days to cover."};

export default async function DataPage() {
  const c = serverApi();
  const from = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const [[markets, ...histories], revenue] = await Promise.all([
    Promise.all([safe(c.markets()), ...TICKERS.map((t) => safe(c.history(t, {interval: "1h", from})))]),
    safe(c.revenue()), // FE-R5
  ]);
  const hist = Object.fromEntries(TICKERS.map((t, i) => [t, histories[i]?.data ?? []]));
  return <DataScreen initial={markets} histories={hist} revenue={revenue} />;
}
