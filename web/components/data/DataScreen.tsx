"use client";
import {useQuery} from "@tanstack/react-query";
import {browserApi, type HistoryPoint} from "@/lib/api";
import {API_URL} from "@/lib/env";
import {DataView} from "./DataView";
import {WeekendPanel} from "./WeekendPanel";

type MarketsResponse = Awaited<ReturnType<ReturnType<typeof browserApi>["markets"]>>;

/** Live data for the dashboard: markets every 5 s (shared cache with the board); history from the server render. */
export function DataScreen({initial, histories}: {initial?: MarketsResponse; histories: Record<string, HistoryPoint[]>}) {
  const q = useQuery({queryKey: ["markets"], queryFn: () => browserApi().markets(), initialData: initial, refetchInterval: 5000});
  const markets = q.data?.data;
  return (
    <DataView
      markets={markets}
      histories={histories}
      asOf={q.data ? {block: q.data.asOfBlock, confirmed: q.data.confirmed} : undefined}
      weekendPanel={markets && <WeekendPanel markets={markets} />}
      apiUrl={API_URL}
    />
  );
}
