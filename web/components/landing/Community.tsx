"use client";

import WorldMap from "./WorldMap";
import { RevealText, ScrollWords, delay } from "./Reveal";

/** Safety: weekend mode, what the code is built on, and where Lendora is (and isn't) available. */
export default function Community() {
  return (
    <section className="community" id="community" aria-labelledby="cm-title">
      <div className="wrap">
        <div className="cm-head">
          <span className="pill on-dark" data-reveal="up">Safety</span>
          <RevealText as="h2" className="cm-title" id="cm-title" d={0.08}>Built so you can always leave</RevealText>
          <ScrollWords className="cm-sub">Repay, close and withdraw never need anyone&apos;s permission, in any region, at any hour.</ScrollWords>
        </div>

        <div className="cm-grid">
          <article className="cm-join" data-reveal="up">
            <h3>Weekend mode,<br />built into<br />the oracle</h3>
            <p>When US markets close, stock prices stop updating. Lendora&apos;s oracle then adds a safety buffer, so borrowers hold extra collateral until the first price after the open.</p>
            <a className="join-btn" href="/terms">
              Read the risks
            </a>
          </article>

          <article className="cm-card cm-reg" data-reveal="up" style={delay(0.12)}>
            <h3>Unmodified<br />Morpho Blue</h3>
            <p>Lending runs on Morpho Blue and Morpho Vault V2 as deployed, not a fork. Lendora&apos;s own contracts go through two independent audits before mainnet, and a guard pauses new borrowing when the price feed looks wrong.</p>
            <div className="mock" aria-hidden="true">
              <div className="mock-back"><div className="bar"></div><p>Health factor 1.62 · Healthy</p></div>
              <div className="mock-front">
                <span className="hexicon"><svg viewBox="0 0 24 24"><path d="M12 3l7 2.6v5.4c0 4.4-3 7.7-7 9.5-4-1.8-7-5.1-7-9.5V5.6z" /><path d="M8.8 12.2l2.2 2.2 4.2-4.4" /></svg></span>
                <p>Repay, close, withdraw: always open</p>
              </div>
            </div>
          </article>

          <article className="cm-card cm-map-card" data-reveal="up" style={delay(0.24)}>
            <h3>Where it&apos;s available</h3>
            <p>Lendora runs on Robinhood Chain. It isn&apos;t offered in the United States, Canada, the United Kingdom, Switzerland, the UAE or sanctioned regions. Anyone with a position can always exit.</p>
            <div className="map"><WorldMap /></div>
          </article>
        </div>
      </div>
    </section>
  );
}
