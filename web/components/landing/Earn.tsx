"use client";

import Link from "next/link";
import { RevealText, ScrollWords, delay } from "./Reveal";

/**
 * USDG Earn on the landing page, in the landing's own style (landing.css, not the app tokens). The APY comes from the
 * vault adapter and is only passed while the vault flag is on; otherwise the block shows no numbers (CP-R7).
 */
export default function Earn({ apy }: { apy?: number }) {
  const on = apy !== undefined;
  return (
    <section className="earn" id="earn" aria-labelledby="earn-title">
      <div className="wrap">
        <div className="earn-head">
          <span className="pill on-dark" data-reveal="up">USDG Earn</span>
          <RevealText as="h2" className="earn-title" id="earn-title" d={0.08}>Put idle USDG to work, hedged against stock prices</RevealText>
          <ScrollWords className="earn-sub">A vault that lends Stock Tokens and shorts the same amount on a perp venue, so you collect lending fees and funding in USDG.</ScrollWords>
        </div>

        <div className="earn-grid">
          <div className="earn-rate" data-reveal="up" style={delay(0)}>
            {on ? (
              <div>
                <p className="earn-apy" data-testid="landing-earn-apy">{(apy * 100).toFixed(2)}%</p>
                <p className="earn-apy-label">net APY (30d, variable). Historical, after costs and fees; not a forecast.</p>
              </div>
            ) : (
              <div>
                <p className="earn-apy soon">Coming soon</p>
                <p className="earn-apy-label">Opens after the simulation gate and a separate audit.</p>
              </div>
            )}
            {on ? (
              <Link className="join-btn earn-cta" href="/vault">See USDG Earn</Link>
            ) : (
              <span className="earn-cta earn-cta-off" aria-disabled="true">Launching after audits</span>
            )}
          </div>
          <ol className="earn-steps">
            {[
              ["Deposit USDG", "You get vault shares. Withdraw instantly up to the cash buffer; larger amounts are paid within 72 hours or at the next US market open."],
              ["Lend Stock Tokens", "The vault buys Stock Tokens and lends about 90% of them to borrowers on Lendora, who pay lending fees."],
              ["Hedge with a perp short", "It shorts the same amount on a perp venue, so stock price moves cancel out. Funding can turn negative, and the venue is a risk."],
            ].map(([t, d], i) => (
              <li key={t} className="earn-step" data-reveal="up" style={delay(0.08 * (i + 1))}>
                <span className="earn-n">{i + 1}</span>
                <h3>{t}</h3>
                <p>{d}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
