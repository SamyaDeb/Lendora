"use client";
import {useState, type ReactNode} from "react";
import {useQueryClient} from "@tanstack/react-query";
import type {Market} from "@/lib/api";
import {FX_MARKETS, FX_MARKETS_PAUSED, FX_MARKETS_WEEKEND, fxChain, fxDetail, fxHistory} from "@/lib/fixtures";
import {E2E_ACCOUNT} from "@/lib/env";
import {StockView} from "@/components/stock/StockView";
import {Portfolio} from "@/components/portfolio/Portfolio";

/** Portfolio fixture: an at-risk NVDA short, a healthy AAPL borrow with lending, SPY lending only. */
const PORTFOLIO: Record<string, {debt?: number; collateral?: number; lent?: number}> = {NVDA: {debt: 10, collateral: 2600, lent: 0}, AAPL: {debt: 3, collateral: 5000, lent: 4.2}, SPY: {lent: 12.3}};
import {MarketsBoardView} from "@/components/markets/MarketsBoardView";

const SETS: Record<string, Market[] | undefined> = {open: FX_MARKETS, weekend: FX_MARKETS_WEEKEND, paused: FX_MARKETS_PAUSED, loading: undefined, error: undefined};

/** Seeds the shared markets cache (so the header's session bar matches), then renders the page view on fixtures. */
export function Preview({page, state, tab}: {page: string; state: string; tab?: string}) {
  const qc = useQueryClient();
  const markets = SETS[state] ?? FX_MARKETS;
  useState(() => {
    if (markets) qc.setQueryData(["markets"], {asOfBlock: "10181", asOfTime: "2026-10-06T20:19:12.000Z", confirmed: true, safe: true, scope: "fixtures", data: markets});
    // Chain state for the action panel and portfolio (the local anvil may not match the repo's addresses).
    for (const m of FX_MARKETS) {
      const pos = page === "portfolio" && state !== "empty" ? PORTFOLIO[m.symbol] : {lent: page === "portfolio" ? 0 : undefined};
      const c = fxChain(m.symbol, Number(m.price.usdPerShare), {weekend: state === "weekend", ...pos});
      qc.setQueryData(["chain", m.symbol, E2E_ACCOUNT], c);
      qc.setQueryData(["chain", m.symbol, null], {...c, user: undefined});
      qc.setQueryData(["market", m.symbol], {asOfBlock: "10181", asOfTime: "2026-10-06T20:19:12.000Z", confirmed: true, safe: true, scope: "fixtures", data: fxDetail(m, state === "weekend")});
    }
    return null;
  });
  const histories = Object.fromEntries(FX_MARKETS.map((m, i) => [m.symbol, fxHistory(m, 24 * 7, i + 1)]));
  const views: Record<string, ReactNode> = {
    stock: (
      <StockView
        symbol="NVDA"
        initial={markets ? {asOfBlock: "10181", asOfTime: "2026-10-06T20:19:12.000Z", confirmed: true, safe: true, scope: "fixtures", data: fxDetail(markets[0], state === "weekend")} : undefined}
        hourly={fxHistory(FX_MARKETS[0], 24 * 7, 1)}
        daily={fxHistory(FX_MARKETS[0], 90, 2).map((p, i) => ({...p, bucket: new Date(Date.parse("2026-10-06T00:00:00Z") - (89 - i) * 86_400_000).toISOString()}))}
        initialTab={(["lend", "borrow", "short"].find((t) => t === tab) as "lend" | "borrow" | "short") ?? "lend"}
      />
    ),
    portfolio: <Portfolio />,
    markets: <MarketsBoardView markets={state === "loading" || state === "error" ? undefined : markets} histories={histories} asOf={state === "loading" || state === "error" ? undefined : {block: "10181", time: "2026-10-06T20:19:12.000Z", confirmed: true}} error={state === "error"} onRetry={() => {}} />,
  };
  return views[page] ?? <p>Unknown preview “{page}”. Try: {Object.keys(views).join(", ")}.</p>;
}
