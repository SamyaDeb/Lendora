"use client";
import {useState} from "react";
import type {HistoryPoint} from "@/lib/api";
import {Segmented} from "@/components/ui";
import {LineChart} from "./LineChart";

/** 06 stock page: utilization and borrow rate, and short-interest history, over 7d (1h buckets) / 30d / 90d (1d). */
export function MarketCharts({hourly, daily}: {hourly: HistoryPoint[]; daily: HistoryPoint[]}) {
  const [range, setRange] = useState<"7d" | "30d" | "90d">("7d");
  const last = daily.length ? Date.parse(daily[daily.length - 1].bucket) / 1000 : 0;
  const pts = range === "7d" ? hourly : daily.filter((p) => Date.parse(p.bucket) / 1000 >= last - (range === "30d" ? 30 : 90) * 86_400);
  const s = (f: (p: HistoryPoint) => number) => pts.map((p) => ({t: Date.parse(p.bucket) / 1000, v: f(p)}));
  return (
    <section aria-labelledby="hist-h" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="hist-h" className="t-title">
          History
        </h2>
        <Segmented
          label="Chart range"
          value={range}
          onChange={setRange}
          options={[
            {value: "7d", label: "7d"},
            {value: "30d", label: "30d"},
            {value: "90d", label: "90d"},
          ]}
        />
      </div>
      <LineChart title="Utilization and borrow rate" subtitle="Rates rise with utilization" a={{label: "Utilization", unit: "%", points: s((p) => Number(p.utilization))}} b={{label: "Borrow APR", unit: "%", color: "var(--borrow)", points: s((p) => Number(p.borrowApr))}} />
      <LineChart title="Short interest" subtitle="Borrowed shares, onchain" a={{label: "Borrowed (shares)", color: "var(--borrow)", points: s((p) => Number(p.borrowed))}} b={{label: "Borrowed (USD)", unit: "$", color: "var(--accent-text)", points: s((p) => Number(p.borrowedUsd))}} />
    </section>
  );
}
