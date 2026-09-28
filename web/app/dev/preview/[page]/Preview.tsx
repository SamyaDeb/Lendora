"use client";
import {useState, type ReactNode} from "react";
import {useQueryClient} from "@tanstack/react-query";
import type {Market} from "@/lib/api";
import {FX_MARKETS, FX_MARKETS_PAUSED, FX_MARKETS_WEEKEND, fxHistory} from "@/lib/fixtures";
import {MarketsBoardView} from "@/components/markets/MarketsBoardView";

const SETS: Record<string, Market[] | undefined> = {open: FX_MARKETS, weekend: FX_MARKETS_WEEKEND, paused: FX_MARKETS_PAUSED, loading: undefined, error: undefined};

/** Seeds the shared markets cache (so the header's session bar matches), then renders the page view on fixtures. */
export function Preview({page, state}: {page: string; state: string}) {
  const qc = useQueryClient();
  const markets = SETS[state] ?? FX_MARKETS;
  useState(() => {
    if (markets) qc.setQueryData(["markets"], {asOfBlock: "10181", asOfTime: "2026-10-06T20:19:12.000Z", confirmed: true, safe: true, scope: "fixtures", data: markets});
    return null;
  });
  const histories = Object.fromEntries(FX_MARKETS.map((m, i) => [m.symbol, fxHistory(m, 24 * 7, i + 1)]));
  const views: Record<string, ReactNode> = {
    markets: <MarketsBoardView markets={state === "loading" || state === "error" ? undefined : markets} histories={histories} asOf={state === "loading" || state === "error" ? undefined : {block: "10181", time: "2026-10-06T20:19:12.000Z", confirmed: true}} error={state === "error"} onRetry={() => {}} />,
  };
  return views[page] ?? <p>Unknown preview “{page}”. Try: {Object.keys(views).join(", ")}.</p>;
}
