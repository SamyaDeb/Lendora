# 00 · Overview

Stockline v1 ships borrowable Stock Token markets (SPY, NVDA, AAPL) on Morpho Blue on Robinhood Chain. It adds a
weekend-safe oracle, a web app and a public short-interest API. The delta-neutral vault (Phase 4) and backstop pool
(Phase 5) come later.

## Problem

Stock Tokens can be bought, held and borrowed *against*, but they cannot be borrowed.

- **Idle holdings.** Fewer than 1 in 20 holders transact monthly, and their tokens earn nothing.
- **No shorting.** When a token trades above its real stock, only buyers can act, so prices drift high (Miller, 1977).
- **Broken weekends.** Minting and burning pause from Saturday to Monday, and Chainlink stock feeds freeze from Friday ~20:00 ET (end of post-market)
  to Sunday 20:00 ET (verified Phase 0, 2026-09-26).
  Off-hours DEX prices drift from the frozen feed; Phase 0 measured weekend premiums of up to 2.5% for SPY, NVDA and
  AAPL (July–September 2026, [WS-C §5](../../sim/reports/phase0-weekend-gaps.md)).
- **Missing yield.** Stablecoins on the chain have few places to earn beyond basic lending.

## Goals (v1, through guarded mainnet)

| ID | Goal |
|---|---|
| G1 | Holders lend Stock Tokens and earn interest in a Morpho market where the stock is the loan asset. |
| G2 | Traders borrow Stock Tokens against USDG or yield-bearing USDG collateral, then short, hedge or arbitrage. |
| G3 | Lenders stay whole through weekends and price gaps: zero bad debt at launch caps. |
| G4 | Stockline publishes per-stock supply, borrows, utilization and borrow rate in real time, onchain and through an API. |
| G5 | Lenders can post their receipt (`rNVDA`) as collateral to borrow USDG. |

## Non-goals (v1)

- A governance token or points program at launch.
- The delta-neutral vault before Phase 4 simulation signs off.
- A custom lending engine. Morpho Blue handles custody, accounting, interest and liquidation.
- Access from the US, Canada, UK, Switzerland or UAE.
- Leverage loops, margin accounts or cross-margin across markets.
- Mobile-native apps. The web app is responsive.

## Success metrics

These are placeholder targets for 90 days after guarded mainnet. Phase 0 interviews will reset them.

| Metric | Target | Source |
|---|---|---|
| Stock supplied (USD) | $5M across 3 markets | Indexer, oracle-priced |
| Average utilization | 20–60% per market | Morpho market state |
| Unique borrowers | 150 | Distinct `onBehalf` addresses |
| Bad debt | $0 | Morpho `Liquidate` events with `badDebtAssets > 0` |
| Liquidations within 2 blocks of eligibility | ≥ 95% | Indexer vs oracle update time |
| Weekend incidents with lender loss | 0 | Post-mortems |
| Short-interest API keys / integrations | 25 / 3 | API gateway |

## Worked example (from litepaper)

Rahul lends 10 NVDA at $100. Priya posts $1,500 USDG, borrows 10 NVDA (LTV 66.7%, under the 77% LLTV) and sells them.

- NVDA falls to $90: she buys back for $900, repays 10 NVDA plus interest, and keeps about $100.
- NVDA rises past about $115.50 (1,500 × 0.77 / 10): she is liquidated. Rahul still gets his NVDA back plus interest.

On weekends the oracle marks NVDA up by the buffer (see [04-oracle.md](04-oracle.md)), so Priya's liquidation price
moves closer. The app shows this before she confirms.
