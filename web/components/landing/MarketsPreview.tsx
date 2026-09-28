"use client";

import { useRef, useState } from "react";
import { useToast } from "./Toast";
import { RevealText, ScrollWords, delay } from "./Reveal";

const ICONS: Record<string, string> = {
  BTC: '<circle cx="12" cy="12" r="8.5"/><path d="M10.2 7.6v8.8M10.2 8h3a1.9 1.9 0 0 1 0 3.8h-3M10.2 11.8h3.4a2.1 2.1 0 0 1 0 4.2h-3.4M11.8 6.3v1.4M11.8 16.3v1.4"/>',
  ETH: '<path d="M6.5 6.5h11M8 12h8M6.5 17.5h11"/>',
  BNB: '<path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z"/><path d="M12 8l4 4-4 4-4-4z"/>',
  ADA: '<circle class="dot" cx="12" cy="12" r="1.9"/><circle class="dot" cx="12" cy="4.5" r="1.3"/><circle class="dot" cx="17.5" cy="6.5" r="1.3"/><circle class="dot" cx="19.5" cy="12" r="1.3"/><circle class="dot" cx="17.5" cy="17.5" r="1.3"/><circle class="dot" cx="12" cy="19.5" r="1.3"/><circle class="dot" cx="6.5" cy="17.5" r="1.3"/><circle class="dot" cx="4.5" cy="12" r="1.3"/><circle class="dot" cx="6.5" cy="6.5" r="1.3"/>',
  SOL: '<rect x="5" y="5" width="14" height="3.6" rx="1.8"/><rect x="5" y="10.2" width="14" height="3.6" rx="1.8"/><rect x="5" y="15.4" width="14" height="3.6" rx="1.8"/>',
  XRP: '<path d="M6 5.5c3 2 4 3.5 6 6.5M18 5.5c-3 2-4 3.5-6 6.5M6 18.5c3-2 4-3.5 6-6.5M18 18.5c-3-2-4-3.5-6-6.5"/>',
  XLM: '<circle cx="12" cy="12" r="7.5"/><path d="M4.5 15.5L19.5 8.5"/>',
  STORJ: '<circle cx="10.5" cy="10.5" r="6"/><path d="M10.5 7.8v5.4M12.3 9.2c-.6-.6-3.1-.6-3.1.7 0 1.7 3.1.7 3.1 2.4 0 1.3-2.5 1.3-3.1.7"/><circle cx="16.5" cy="16.5" r="4"/>',
};

const MARKET: Record<string, [string, number]> = {
  BTC: ["Bitcoin", 43478], ETH: ["Ethereum", 2350], BNB: ["Binance Coin", 312.4], ADA: ["Cardano", 0.582],
  SOL: ["Solana", 98], XRP: ["Xrp", 0.621], XLM: ["Stellar", 0.11], STORJ: ["Storj", 0.491],
  SUI: ["Sui", 1.46], SEI: ["Sei", 0.412], APT: ["Aptos", 8.92], TIA: ["Celestia", 9.87],
  JUP: ["Jupiter", 0.721], PYTH: ["Pyth", 0.334], ARB: ["Arbitrum", 1.084], OP: ["Optimism", 2.31],
};

type Row = [string, number];
const LISTS: Record<string, Row[]> = {
  gainers: [["BTC", 11.76], ["ETH", 9.43], ["BNB", 8.73], ["ADA", 8.53], ["SOL", 7.91], ["XRP", 7.28], ["XLM", 6.84], ["STORJ", 6.37]],
  decliners: [["XRP", -7.84], ["ADA", -6.52], ["SOL", -5.9], ["XLM", -5.13], ["BNB", -4.47], ["ETH", -3.28], ["BTC", -2.06], ["STORJ", -1.85]],
  fresh: [["SUI", 14.2], ["TIA", 8.05], ["OP", 6.33], ["APT", 5.71], ["ARB", 4.62], ["JUP", 2.94], ["PYTH", -1.48], ["SEI", -3.36]],
  cap: [["BTC", 1.24], ["ETH", -0.86], ["BNB", 0.42], ["SOL", 2.35], ["XRP", -1.12], ["ADA", 0.68], ["XLM", -0.37], ["STORJ", 3.05]],
};

const TABS = [
  { key: "gainers", id: "tab-gainers", label: "Top Gainers" },
  { key: "decliners", id: "tab-decliners", label: "Top Decliners" },
  { key: "fresh", id: "tab-new", label: "New Markets" },
  { key: "cap", id: "tab-cap", label: "Top By Market Cap" },
];

function money(n: number) {
  return "$ " + (n >= 1 ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : n.toFixed(4));
}

function CoinIcon({ sym }: { sym: string }) {
  const body = ICONS[sym] ?? `<circle cx="12" cy="12" r="8.5"/><text x="12" y="16" text-anchor="middle" font-size="10">${sym.charAt(0)}</text>`;
  return <svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: body }} />;
}

export default function Markets() {
  const toast = useToast();
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

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
        <RevealText as="h2" className="mk-title" id="mk-title" d={0.08}>Seize new opportunities for trade and investment</RevealText>
        <ScrollWords className="mk-sub">Quickly purchase top cryptocurrencies, become a crypto owner in minutes using your debit or credit card.</ScrollWords>

        <div className="mk-bar" data-reveal="up" style={delay(0.1)}>
          <div className="tabs" role="tablist" aria-label="Market lists">
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
          <button className="more" type="button" onClick={() => toast("The full markets list isn't part of this prototype.")}>
            Explore More
          </button>
        </div>

        <div className="coin-grid" id="coin-grid" data-reveal="grid" role="tabpanel" aria-labelledby={TABS[active].id}>
          {LISTS[TABS[active].key].map(([sym, pct], idx) => {
            const m = MARKET[sym];
            const up = pct >= 0;
            const arrow = up ? "M5.5 9.5L8 7l2.5 2.5" : "M5.5 6.5L8 9l2.5-2.5";
            return (
              <a
                key={TABS[active].key + sym}
                className="mcoin"
                style={{ "--i": idx } as React.CSSProperties}
                href="#"
                data-sym={sym}
                onClick={(e) => {
                  e.preventDefault();
                  toast(`Trading ${sym} isn't part of this prototype.`);
                }}
              >
                <span className="tile-ico"><CoinIcon sym={sym} /></span>
                <span className="sym">{sym}</span>
                <span className="nm">{m[0]}</span>
                <span className={"chg " + (up ? "up" : "down")}>
                  <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" /><path d={arrow} /></svg>
                  <span>
                    <span className="sr-only">{up ? "Up " : "Down "}</span>
                    {Math.abs(pct).toFixed(2)}&nbsp;%
                  </span>
                </span>
                <span className="px">{money(m[1])}</span>
              </a>
            );
          })}
        </div>
        <p className="mk-note">Prices and 24-hour changes are illustrative.</p>
      </div>
    </section>
  );
}
