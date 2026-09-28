"use client";

import { useRef, useState } from "react";
import type { Market } from "@/lib/api";
import { RevealText, ScrollWords, delay } from "./Reveal";

/** Names for the tiles; anything not listed reads "Stock Token". */
const NAMES: Record<string, string> = { NVDA: "NVIDIA", AAPL: "Apple", SPY: "S&P 500 ETF", TSLA: "Tesla", MSFT: "Microsoft", AMZN: "Amazon", GOOGL: "Alphabet", META: "Meta" };

type Key = "lend" | "borrow" | "util" | "si";
const TABS: { key: Key; id: string; label: string; unit: string; val: (m: Market) => number; tone: "up" | "down" | "flat" }[] = [
  { key: "lend", id: "tab-lend", label: "Lend APY", unit: "lend APY", val: (m) => m.supplyApy, tone: "up" },
  { key: "borrow", id: "tab-borrow", label: "Borrow APR", unit: "borrow APR", val: (m) => Number(m.borrowApr), tone: "flat" },
  { key: "util", id: "tab-util", label: "Utilization", unit: "utilized", val: (m) => Number(m.utilization), tone: "flat" },
  { key: "si", id: "tab-si", label: "Short interest", unit: "of float shorted", val: (m) => Number(m.siPctFloat), tone: "flat" },
];

const pct = (v: number) => `${(v * 100).toFixed(v * 100 < 1 ? 3 : 2)}\u00a0%`;
const money = (n: number) => "$ " + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Live rates per Stock Token (public API), ranked by the selected tab. Without data, the tickers without numbers. */
export default function Markets({ markets, tickers, asOfBlock }: { markets?: Market[]; tickers: string[]; asOfBlock?: string }) {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tab = TABS[active];
  const rows = markets ? [...markets].sort((a, b) => tab.val(b) - tab.val(a)) : undefined;

  const select = (i: number, focus: boolean) => {
    setActive(i);
    if (focus) tabRefs.current[i]?.focus();
  };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = TABS.length;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (i + 1) % n;
    else if (e.key === "ArrowLeft") next = (i - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next !== null) {
      e.preventDefault();
      select(next, true);
    }
  };

  return (
    <section className="markets" id="markets" aria-labelledby="mk-title">
      <svg className="hex" viewBox="0 -10 400 470" aria-hidden="true">
        <defs>
          <linearGradient id="hexA" gradientUnits="userSpaceOnUse" x1="4" y1="0" x2="149" y2="221"><stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset="1" stopColor="#fff" stopOpacity="0.4" /></linearGradient>
          <linearGradient id="hexB" gradientUnits="userSpaceOnUse" x1="149" y1="239" x2="4" y2="455"><stop offset="0" stopColor="#fff" stopOpacity="0.4" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
        </defs>
        <path className="fade-a" d="M4 -2L149 221" />
        <path d="M149 221H400" />
        <path className="fade-b" d="M149 239L4 455" />
        <path d="M149 238H400" opacity="0.8" />
      </svg>
      <div className="wrap">
        <span className="pill on-dark" data-reveal="up">Markets</span>
        <RevealText as="h2" className="mk-title" id="mk-title" d={0.08}>Live rates for every Stock Token</RevealText>
        <ScrollWords className="mk-sub">Lenders earn more when more of a stock is borrowed. Borrow rates climb steeply near the cap, so lenders can always get out.</ScrollWords>

        <div className="mk-bar" data-reveal="up" style={delay(0.1)}>
          <div className="tabs" role="tablist" aria-label="Rank markets by">
            {TABS.map((t, i) => (
              <button
                key={t.key}
                ref={(el) => { tabRefs.current[i] = el; }}
                className="tab"
                type="button"
                role="tab"
                id={t.id}
                aria-selected={i === active}
                aria-controls="coin-grid"
                tabIndex={i === active ? 0 : -1}
                onClick={() => select(i, false)}
                onKeyDown={(e) => onKey(e, i)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <a className="more" href="/markets">All markets</a>
        </div>

        <div className="coin-grid" id="coin-grid" data-reveal="grid" role="tabpanel" aria-labelledby={tab.id}>
          {(rows ?? tickers.map((s) => ({ symbol: s }) as Market)).map((m, idx) => {
            const v = rows ? tab.val(m) : undefined;
            return (
              <a key={tab.key + m.symbol} className="mcoin" style={{ "--i": idx } as React.CSSProperties} href={`/stock/${m.symbol}`} data-sym={m.symbol}>
                <span className="tile-ico tile-tk" aria-hidden="true">{m.symbol.slice(0, 4)}</span>
                <span className="sym">{m.symbol}</span>
                <span className="nm">{NAMES[m.symbol] ?? "Stock Token"}</span>
                <span className={"chg " + (tab.tone === "up" ? "up" : tab.tone === "down" ? "down" : "")}>
                  {v !== undefined ? `${pct(v)} ${tab.unit}` : "Rate unavailable"}
                </span>
                <span className="px">{rows ? money(Number(m.price.usdPerShare)) : "–"}</span>
              </a>
            );
          })}
        </div>
        <p className="mk-note">
          {rows
            ? `Variable rates from the public API${asOfBlock ? ` at block ${asOfBlock}` : ""}. Prices per share from Chainlink.`
            : "Live rates are unavailable right now. The app reads them from the chain."}
        </p>
      </div>
    </section>
  );
}
