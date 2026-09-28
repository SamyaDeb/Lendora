import {notFound} from "next/navigation";
import {safe, serverApi} from "@/lib/api";
import {TICKERS} from "@/lib/env";
import {StockView} from "@/components/stock/StockView";
import type {ActionTab} from "@/components/stock/ActionPanel";

export async function generateMetadata({params}: {params: Promise<{ticker: string}>}) {
  return {title: `${(await params).ticker.toUpperCase()}`};
}

const TABS: ActionTab[] = ["lend", "borrow", "short"];

export default async function StockPage({params, searchParams}: {params: Promise<{ticker: string}>; searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  const symbol = (await params).ticker.toUpperCase();
  if (!TICKERS.includes(symbol)) notFound();
  const tabParam = (await searchParams).tab;
  const tab = TABS.find((t) => t === tabParam) ?? "lend";
  const c = serverApi();
  const [detail, hourly, daily] = await Promise.all([safe(c.market(symbol)), safe(c.history(symbol, {interval: "1h"})), safe(c.history(symbol, {interval: "1d", from: new Date(Date.now() - 400 * 86_400_000).toISOString()}))]);
  return <StockView symbol={symbol} initial={detail} hourly={hourly?.data ?? []} daily={daily?.data ?? []} initialTab={tab} />;
}
