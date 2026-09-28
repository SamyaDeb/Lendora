"use client";

import { RevealText, ScrollWords, delay } from "./Reveal";

/** What Lendora does, one card per product, each opening the part of the app it describes. */
export default function Opportunity({ vault }: { vault: boolean }) {

  return (
    <section className="opportunity" id="products" aria-labelledby="op-title">
      <div className="op-bg" aria-hidden="true"></div>
      <div className="wrap">
        <div className="op-head">
          <span className="pill" data-reveal="up">Products</span>
          <RevealText as="h2" id="op-title" d={0.08}>Stock lending, the way it works on Wall Street, from your wallet.</RevealText>
          <ScrollWords>Lendora is a lending market for Stock Tokens on Robinhood Chain, built on unmodified Morpho Blue. Rates are variable and set by supply and demand.</ScrollWords>
        </div>

        <div className="cards">
          <div className="cards-row three">
            <a data-reveal="up" style={delay(0)} className="card" href="/markets">
              <svg className="deco" viewBox="0 0 395 235" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M203 0L367 25L392 176" /><path d="M374 19L394 1" /><path d="M381 23L396 8" /></svg>
              <svg className="ico" viewBox="0 0 48 48" aria-hidden="true"><rect x="13" y="5" width="22" height="38" rx="5" /><path d="M21 12h6" /><circle cx="24" cy="35" r="2.6" /></svg>
              <div className="txt"><h3>Lend</h3><p>Deposit Stock Tokens and earn the fees borrowers pay. You get rSTOCK back and can withdraw what isn&apos;t lent out.</p></div>
            </a>
            <a data-reveal="up" style={delay(0.1)} className="card" href="/markets">
              <svg className="deco" viewBox="0 0 395 235" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M310 23L363 37L392 176" /><path d="M356 34L372 28" /></svg>
              <svg className="ico" viewBox="0 0 48 48" aria-hidden="true"><defs><mask id="icm1" maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48"><rect width="48" height="48" fill="#fff" /><rect x="5" y="9" width="31" height="23" rx="7" fill="#000" /></mask></defs><rect x="13" y="15" width="31" height="23" rx="7" mask="url(#icm1)" /><rect className="under" x="5" y="9" width="31" height="23" rx="7" /><circle cx="20.5" cy="20.5" r="4" /><path d="M12 17.5v6M29 17.5v6" /></svg>
              <div className="txt"><h3>Borrow</h3><p>Borrow a Stock Token against USDG to hedge. A 24-hour safety check, weekends included, runs before you open.</p></div>
            </a>
            <a data-reveal="up" style={delay(0.2)} className="card" href="/markets">
              <svg className="deco" viewBox="0 0 395 235" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M217 1L356 33L392 176" /><path d="M356 36L392 2" /><path d="M364 39L394 10" /></svg>
              <svg className="ico" viewBox="0 0 48 48" aria-hidden="true"><defs><mask id="icm2" maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48"><rect width="48" height="48" fill="#fff" /><rect x="20" y="16" width="22" height="16" rx="4" fill="#000" /></mask></defs><path d="M22 5l15 8.5v17L22 39 7 30.5v-17z" mask="url(#icm2)" /><rect className="under" x="20" y="16" width="22" height="16" rx="4" /><path d="M20 22h22M25 27h6" /></svg>
              <div className="txt"><h3>Short</h3><p>Borrow and sell for USDG in one transaction. Close by buying back; liquidation happens at a health factor of 1.00.</p></div>
            </a>
          </div>

          <div className="cards-row two">
            <a data-reveal="up" style={delay(0)} className="card featured" href="/data">
              <svg className="deco" viewBox="0 0 604 336" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M398 3L502 163L604 163" /></svg>
              <svg className="ico" viewBox="0 0 48 48" aria-hidden="true"><rect x="8" y="10" width="32" height="27" rx="10" transform="rotate(28 24 24)" /><circle cx="17.5" cy="19.5" r="3.8" /><path d="M24 31l8-7" /></svg>
              <div className="txt"><h3>Short-interest data</h3><p>Every borrow on Lendora is public. See live short interest, borrow rates and days to cover for each Stock Token, with charts that mark weekends and holidays. The same numbers come from a free API and an onchain lens contract, so you can build on them.</p></div>
            </a>
            <a data-reveal="up" style={delay(0.1)} className="card wallet" href={vault ? "/vault" : "/alerts"}>
              <svg className="deco" viewBox="0 0 604 336" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M408 336L511 174L604 174" /></svg>
              <svg className="ico" viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="12" width="36" height="26" rx="6" /><path d="M6 20h36" /><path d="M14 30h8" /><circle cx="34" cy="30" r="3" /></svg>
              <div className="txt"><h3>{vault ? "USDG Earn" : "Alerts"}</h3><p>{vault ? "Lending fees and perp funding on USDG, hedged against stock price moves. Variable." : "A message when your health factor drops, and before weekend mode starts."}</p></div>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
