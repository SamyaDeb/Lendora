"use client";

import { useToast } from "./Toast";
import { RevealText, ScrollWords, delay } from "./Reveal";

export default function Opportunity() {
  const toast = useToast();
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    toast("Product pages aren't part of this prototype.");
  };

  return (
    <section className="opportunity" id="products" aria-labelledby="op-title">
      <div className="op-bg" aria-hidden="true"></div>
      <div className="wrap">
        <div className="op-head">
          <span className="pill" data-reveal="up">Opportunity</span>
          <RevealText as="h2" id="op-title" d={0.08}>Discover your upcoming cryptocurrency investment chance.</RevealText>
          <ScrollWords>Join us on an extensive exploration as we explore the complex and dynamic world of cryptocurrency</ScrollWords>
        </div>

        <div className="cards">
          <div className="cards-row three">
            <a data-reveal="up" style={delay(0)} className="card" href="#" onClick={open}>
              <svg className="deco" viewBox="0 0 395 235" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M203 0L367 25L392 176" /><path d="M374 19L394 1" /><path d="M381 23L396 8" /></svg>
              <svg className="ico" viewBox="0 0 48 48" aria-hidden="true"><rect x="13" y="5" width="22" height="38" rx="5" /><path d="M21 12h6" /><circle cx="24" cy="35" r="2.6" /></svg>
              <div className="txt"><h3>Exchange App</h3><p>This comprehensive application</p></div>
            </a>
            <a data-reveal="up" style={delay(0.1)} className="card" href="#" onClick={open}>
              <svg className="deco" viewBox="0 0 395 235" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M310 23L363 37L392 176" /><path d="M356 34L372 28" /></svg>
              <svg className="ico" viewBox="0 0 48 48" aria-hidden="true"><defs><mask id="icm1" maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48"><rect width="48" height="48" fill="#fff" /><rect x="5" y="9" width="31" height="23" rx="7" fill="#000" /></mask></defs><rect x="13" y="15" width="31" height="23" rx="7" mask="url(#icm1)" /><rect className="under" x="5" y="9" width="31" height="23" rx="7" /><circle cx="20.5" cy="20.5" r="4" /><path d="M12 17.5v6M29 17.5v6" /></svg>
              <div className="txt"><h3>Exchange Plus</h3><p>Exchange Plus is the latest addition</p></div>
            </a>
            <a data-reveal="up" style={delay(0.2)} className="card" href="#" onClick={open}>
              <svg className="deco" viewBox="0 0 395 235" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M217 1L356 33L392 176" /><path d="M356 36L392 2" /><path d="M364 39L394 10" /></svg>
              <svg className="ico" viewBox="0 0 48 48" aria-hidden="true"><defs><mask id="icm2" maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48"><rect width="48" height="48" fill="#fff" /><rect x="20" y="16" width="22" height="16" rx="4" fill="#000" /></mask></defs><path d="M22 5l15 8.5v17L22 39 7 30.5v-17z" mask="url(#icm2)" /><rect className="under" x="20" y="16" width="22" height="16" rx="4" /><path d="M20 22h22M25 27h6" /></svg>
              <div className="txt"><h3>Instant Buy</h3><p>With intuitive multi-currency support</p></div>
            </a>
          </div>

          <div className="cards-row two">
            <a data-reveal="up" style={delay(0)} className="card featured" href="#" onClick={open}>
              <svg className="deco" viewBox="0 0 604 336" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M398 3L502 163L604 163" /></svg>
              <svg className="ico" viewBox="0 0 48 48" aria-hidden="true"><rect x="8" y="10" width="32" height="27" rx="10" transform="rotate(28 24 24)" /><circle cx="17.5" cy="19.5" r="3.8" /><path d="M24 31l8-7" /></svg>
              <div className="txt"><h3>Crypto Rewards</h3><p>Lendora Earn is an umbrella program that houses our crypto Staking and Savings services. Each requires little effort, and serves as an intuitive path for participants to start enjoying regular crypto rewards, simply by holding certain digital assets. Prizes and all funds are fully accessible, and can be withdrawn or transferred at any time</p></div>
            </a>
            <a data-reveal="up" style={delay(0.1)} className="card wallet" href="#" onClick={open}>
              <svg className="deco" viewBox="0 0 604 336" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M408 336L511 174L604 174" /></svg>
              <svg className="ico" viewBox="0 0 48 48" aria-hidden="true"><defs><mask id="icm3" maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48"><rect width="48" height="48" fill="#fff" /><rect x="30" y="2" width="15" height="21" fill="#000" /></mask></defs><rect x="5" y="12" width="34" height="28" rx="5" mask="url(#icm3)" /><path d="M13 30h4M21 30h4" /><path d="M34 5v15M34 6.5h5a3 3 0 0 1 0 6h-5M34 12.5h6a3.2 3.2 0 0 1 0 6.5h-6M36.5 3.5v3M36.5 19v3" /></svg>
              <div className="txt"><h3>Crypto Wallet</h3><p>Experience a wide range of top and trending cryptocurrencies</p></div>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
