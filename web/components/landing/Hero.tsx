"use client";

import { useEffect, useRef, useState } from "react";
import type { Market } from "@/lib/api";
import { totals } from "@/lib/market";

/** The rolling word: the Stock Tokens you can lend and borrow (the listed tickers first, then the general term). */
const rollFor = (tickers: string[]) => [...tickers.slice(0, 3), "Stock Tokens"];

const usdShort = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`);

export default function Hero({ markets, tickers }: { markets?: Market[]; tickers: string[] }) {
  const ROLL = rollFor(tickers);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cur, setCur] = useState(0);
  const [out, setOut] = useState<number | null>(null);
  const curRef = useRef(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const roll = setInterval(() => {
      if (document.hidden) return;
      const prev = curRef.current;
      curRef.current = (prev + 1) % ROLL.length;
      setOut(prev);
      setCur(curRef.current);
      timers.push(setTimeout(() => setOut((o) => (o === prev ? null : o)), 1000));
    }, 3600);
    return () => {
      clearInterval(roll);
      timers.forEach(clearTimeout);
    };
  }, [ROLL.length]);

  // Live totals from the public API; without them, what the product is (no invented numbers).
  const t = markets?.length ? totals(markets) : undefined;
  const stats: [string, string][] = t
    ? [
        ["Stocks listed", String(markets!.length)],
        ["Lent", usdShort(t.suppliedUsd)],
        ["Borrowed", usdShort(t.borrowedUsd)],
      ]
    : [
        ["Stocks listed", String(tickers.length)],
        ["Built on", "Morpho"],
        ["Custody", "Yours"],
      ];

  return (
    <div className="hero">
      <header className="site-header">
        <div className="wrap">
          <a className="brand" href="/" aria-label="Lendora home">
            <img src="/landing-logo.png" alt="" />
            <span className="brand-name">Lendora</span>
          </a>

          <nav
            className={"nav" + (menuOpen ? " open" : "")}
            id="site-nav"
            aria-label="Primary"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("a")) setMenuOpen(false);
            }}
          >
            <ul>
              <li><a href="#products">Products</a></li>
              <li><a href="#markets">Markets</a></li>
              <li><a href="#community">Safety</a></li>
              <li><a href="#articles">Learn</a></li>
            </ul>
          </nav>

          <div className="actions">
            <a className="register wallet" href="/markets">
              Launch App
            </a>
            <button
              className="menu-btn"
              id="menu-btn"
              type="button"
              aria-expanded={menuOpen}
              aria-controls="site-nav"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14M3 14h14" /></svg>
            </button>
          </div>
        </div>
      </header>

      <main className="hero-main">
        <div className="hero-wrap">
          <h1 className="hd" id="headline">
            <span className="sr-only">Lend and borrow Stock Tokens on Robinhood Chain</span>
            <span className="hd-top" aria-hidden="true">
              <span>Lend and borrow</span>
              <span className="hd-roll">
                {ROLL.map((w, i) => (
                  <span key={w} className={i === cur ? "is-cur" : i === out ? "is-out" : undefined}>
                    {w}
                  </span>
                ))}
              </span>
            </span>
            <span className="hd-line" aria-hidden="true">on Robinhood Chain</span>
          </h1>

          <hr className="hero-rule" />

          <div className="hero-foot">
            <a className="trade-btn" href="/markets">
              <span className="go" aria-hidden="true">
                <svg viewBox="0 0 8 8"><path d="M1.5 6.5l5-5M2.5 1.5h4v4" /></svg>
              </span>
              Launch app
            </a>
            <p className="hero-desc">
              Earn what borrowers pay on your Stock Tokens, or borrow them to short or hedge. Non-custodial, on Morpho Blue.
            </p>
            <dl className="hero-stats" data-testid="hero-stats" data-live={t ? "1" : "0"}>
              {stats.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </main>
    </div>
  );
}
