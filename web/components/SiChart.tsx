"use client";
import {useState} from "react";
import type {HistoryPoint} from "@/lib/api";
import {LineChart} from "./LineChart";

/** 07 §4 per-stock chart: short interest and borrow APR over time, weekends shaded. */
export function SiChart({histories}: {histories: Record<string, HistoryPoint[]>}) {
  const tickers = Object.keys(histories);
  const [t, setT] = useState(tickers.includes("NVDA") ? "NVDA" : tickers[0]);
  const pts = histories[t] ?? [];
  const s = (f: (p: HistoryPoint) => number) => pts.map((p) => ({t: Date.parse(p.bucket) / 1000, v: f(p)}));
  return (
    <section className="space-y-2" aria-label="Short interest history">
      <div className="flex items-center gap-2">
        <label htmlFor="si-stock" className="text-sm font-medium">
          Stock
        </label>
        <select id="si-stock" className="input w-auto" value={t} onChange={(e) => setT(e.target.value)}>
          {tickers.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </div>
      <LineChart title={`${t} short interest`} a={{label: "Borrowed (shares)", points: s((p) => Number(p.borrowed))}} b={{label: "Borrow APR", unit: "%", points: s((p) => Number(p.borrowApr))}} />
    </section>
  );
}
