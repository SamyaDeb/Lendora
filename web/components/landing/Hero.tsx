"use client";

import { useEffect, useRef, useState } from "react";

const ROLL = ["from 7 blockchains", "100+ crypto tokens", "multiple asset classes"];

export default function Hero() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [cur, setCur] = useState(0);
  const [out, setOut] = useState<number | null>(null);
  const [oi, setOi] = useState(84);
  const [prevOi, setPrevOi] = useState<number | null>(null);
  const [go, setGo] = useState(false);
  const curRef = useRef(0);
  const oiRef = useRef(84);

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

    const tick = setInterval(() => {
      if (document.hidden) return;
      const old = oiRef.current;
      oiRef.current = old + 1 > 92 ? 84 : old + 1;
      setPrevOi(old);
      setOi(oiRef.current);
      setGo(false);
      // two frames so the "pre" state is painted before the transition starts
      requestAnimationFrame(() => requestAnimationFrame(() => setGo(true)));
      timers.push(
        setTimeout(() => {
          setPrevOi(null);
          setGo(false);
        }, 800)
      );
    }, 7000);

    return () => {
      clearInterval(roll);
      clearInterval(tick);
      timers.forEach(clearTimeout);
    };
  }, []);

  const noop = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="hero">
      <header className="site-header">
        <div className="wrap">
          <a className="brand" href="#" aria-label="Lendora home" onClick={noop}>
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
              <li><a href="#markets">Prices</a></li>
              <li><a href="#articles">Article</a></li>
              <li><a href="#community">Company</a></li>
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
            <span className="sr-only">
              Trade from 7 blockchains, 100+ crypto tokens and multiple asset classes from your wallet
            </span>
            <span className="hd-top" aria-hidden="true">
              <span>Trade</span>
              <span className="hd-roll">
                {ROLL.map((t, i) => (
                  <span key={t} className={i === cur ? "is-cur" : i === out ? "is-out" : undefined}>
                    {t}
                  </span>
                ))}
              </span>
            </span>
            <span className="hd-line" aria-hidden="true">from your wallet</span>
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
              Non-custodial crypto trading with deep liquidity and low costs, built for everyone
            </p>
            <dl className="hero-stats">
              <div><dt>Traders</dt><dd>128K</dd></div>
              <div>
                <dt>Open interest</dt>
                <dd id="stat-oi">
                  {prevOi !== null && (
                    <span key={"old" + prevOi} className={"tk-new tk-old" + (go ? " go" : "")}>${prevOi}M</span>
                  )}
                  <span key={"new" + oi} className={"tk-new" + (prevOi !== null ? (go ? " go" : " pre") : "")}>
                    ${oi}M
                  </span>
                </dd>
              </div>
              <div>
                <dt>
                  Total volume{" "}
                  <svg viewBox="0 0 6 9" aria-hidden="true"><path d="M1 1l3.5 3.5L1 8" /></svg>
                </dt>
                <dd>$1.2B</dd>
              </div>
            </dl>
          </div>
        </div>
      </main>
    </div>
  );
}
