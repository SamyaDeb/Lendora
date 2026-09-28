"use client";

import { RevealText, ScrollWords, delay } from "./Reveal";

/** Closing call to action. (Replaces the prototype's email form, which sent nothing.) */
export default function Subscribe() {
  return (
    <section className="subscribe" id="start" aria-labelledby="sb-title">
      <div className="wrap">
        <div className="sb-head">
          <span className="pill on-dark" data-reveal="up">Get started</span>
          <RevealText as="h2" className="sb-title" id="sb-title" d={0.08}>Connect a wallet on Robinhood Chain <br className="br-wide" />and pick a stock</RevealText>
          <ScrollWords className="sb-sub">Lending needs a Stock Token; borrowing and shorting need USDG as collateral. Set up alerts so a falling health factor never catches you by surprise.</ScrollWords>
        </div>
        <div className="sb-ctas" data-reveal="up" style={delay(0.15)}>
          <a className="join-btn" href="/markets">Launch app</a>
          <a className="more" href="/alerts">Set up alerts</a>
        </div>
      </div>
    </section>
  );
}
