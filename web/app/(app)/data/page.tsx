import {safe, serverApi} from "@/lib/api";
import {TICKERS} from "@/lib/env";
import {DataScreen} from "@/components/data/DataScreen";

export const metadata = {title: "Short interest", description: "Live short interest for Stock Tokens on Robinhood Chain: borrowed shares, % of float, borrow rates, days to cover."};

export default async function DataPage() {
  const c = serverApi();
  const from = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const [markets, ...histories] = await Promise.all([safe(c.markets()), ...TICKERS.map((t) => safe(c.history(t, {interval: "1h", from})))]);
  // FE-R5: the 90 days ending at the chain's date (the API defaults to the server's clock, which a local or test chain
  // can run ahead of).
  const to = markets?.asOfTime.slice(0, 10);
  const revenue = await safe(c.revenue(to ? {to, from: new Date(Date.parse(`${to}T00:00:00Z`) - 89 * 86_400_000).toISOString().slice(0, 10)} : {}));
  const hist = Object.fromEntries(TICKERS.map((t, i) => [t, histories[i]?.data ?? []]));
  return <DataScreen initial={markets} histories={hist} revenue={revenue} />;
}
