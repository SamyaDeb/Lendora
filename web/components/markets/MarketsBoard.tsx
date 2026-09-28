"use client";
import {useQueries, useQuery} from "@tanstack/react-query";
import {browserApi} from "@/lib/api";
import {TICKERS} from "@/lib/env";
import {MarketsBoardView} from "./MarketsBoardView";

type MarketsResponse = Awaited<ReturnType<ReturnType<typeof browserApi>["markets"]>>;

const WEEK_AGO = () => new Date(Date.now() - 7 * 86_400_000).toISOString();

/** Data for the board: markets every 5 s (APP-R7), 7-day hourly history per stock for the rate sparklines (1 min). */
export function MarketsBoard({initial}: {initial?: MarketsResponse}) {
  const q = useQuery({queryKey: ["markets"], queryFn: () => browserApi().markets(), initialData: initial, refetchInterval: 5000});
  const hist = useQueries({
    queries: TICKERS.map((t) => ({queryKey: ["history7d", t], queryFn: () => browserApi().history(t, {interval: "1h", from: WEEK_AGO()}), staleTime: 60_000, refetchInterval: 60_000})),
  });
  const histories = Object.fromEntries(TICKERS.map((t, i) => [t, hist[i].data?.data]));
  return (
    <MarketsBoardView
      markets={q.data?.data}
      histories={histories}
      asOf={q.data ? {block: q.data.asOfBlock, time: q.data.asOfTime, confirmed: q.data.confirmed} : undefined}
      error={q.isError}
      onRetry={() => q.refetch()}
    />
  );
}
