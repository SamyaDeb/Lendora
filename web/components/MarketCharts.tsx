"use client";
import {useState} from "react";
import type {HistoryPoint} from "@/lib/api";
import {LineChart} from "./LineChart";

/** 06 market detail: rate and utilization, and short interest, over 7d (1h buckets) / 30d / 90d (1d buckets). */
export function MarketCharts({hourly, daily}: {hourly: HistoryPoint[]; daily: HistoryPoint[]}) {
  const [range, setRange] = useState<"7d" | "30d" | "90d">("7d");
  const last = daily.length ? Date.parse(daily[daily.length - 1].bucket) / 1000 : 0;
  const pts = range === "7d" ? hourly : daily.filter((p) => Date.parse(p.bucket) / 1000 >= last - (range === "30d" ? 30 : 90) * 86_400);
  const s = (f: (p: HistoryPoint) => number) => pts.map((p) => ({t: Date.parse(p.bucket) / 1000, v: f(p)}));
  return (
    <section aria-label="History" className="space-y-3">
      <div role="radiogroup" aria-label="Range" className="flex gap-2">
        {(["7d", "30d", "90d"] as const).map((r) => (
          <button key={r} role="radio" aria-checked={range === r} className={`btn ${range === r ? "" : "btn-ghost"}`} onClick={() => setRange(r)}>
            {r}
          </button>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <LineChart title="Rate and utilization" a={{label: "Utilization", unit: "%", points: s((p) => Number(p.utilization))}} b={{label: "Borrow APR", unit: "%", points: s((p) => Number(p.borrowApr))}} />
        <LineChart title="Short interest" a={{label: "Borrowed (shares)", points: s((p) => Number(p.borrowed))}} b={{label: "Borrowed (USD)", unit: "$", points: s((p) => Number(p.borrowedUsd))}} />
      </div>
    </section>
  );
}
