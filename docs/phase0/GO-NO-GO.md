# Phase 0 · Go / no-go memo

*2026-09-27. Scope: Lendora v1 (SPY, NVDA, AAPL stock-loan markets on Morpho Blue, Robinhood Chain).*

## Recommendation: **Go with changes** (technical). Market validation and legal are **pending**.

Nothing technical blocks the product. Stock Tokens move exactly into contracts and into Morpho, and Morpho is live
with the IRM and LLTVs we need. Chainlink feeds exist for all three stocks and USDG, liquidators are active, and
weekend premiums are far smaller than the litepaper assumed.

Four changes are required before Phase 1 continues (details in [04-prd-decisions.md](04-prd-decisions.md)):

1. Fix the oracle's multiplier double-count (D1); left as is, it would crash `price()` 75% on a 4:1 split.
2. Design for the issuer's blocklist, pause and `adminBurn` powers (D4, D9, D10).
3. Move to Morpho Vault V2 or self-deploy MetaMorpho (D6); no MetaMorpho v1 factory exists on this chain.
4. Add scheduled-event buffers and a feed sanity band (D4, D5).

The business case can't be judged yet: weekend arbitrage demand is small, so the case rests on perp-maker hedging
and lender yield. The interviews must show that.

## Critical checks

| Check | Status | Evidence |
|---|---|---|
| Stock Tokens transferable into contracts (wrapper, Morpho) | **Pass.** Exact amounts; raw Stock Tokens already a Morpho loan asset in 19 markets | [02 · StockTokenTransfer](02-fork-validation.md), [01 §2](01-chain-facts.md#2-morpho) |
| Issuer controls over those contracts | **Risk.** Single-key blocklist, token/global pause, `adminBurn`; no timelock; no allowlist | [01 §3.2](01-chain-facts.md#32-admin-powers-a3-lm-r6-cp-r5), [02 · StockTokenAdmin](02-fork-validation.md) |
| Morpho Blue with AdaptiveCurveIRM and LLTV 77% / 62.5% (+ irm 0, lltv 0) | **Pass** | [01 §2](01-chain-facts.md#2-morpho), fork `MorphoMarket` |
| MetaMorpho v1.1 factory | **Fail → change.** Absent; Vault V2 live (70 vaults) | [01 §2](01-chain-facts.md#2-morpho), D6 |
| Chainlink feeds adequate | **Pass with changes.** 8 dp, 0.5%/24 h, 24/5, multiplier included, pause flag on the token; **no sequencer uptime feed**; launch-week 1e18 scaling incident | [01 §4](01-chain-facts.md#4-chainlink), [WS-C §0–1](../../sim/reports/phase0-weekend-gaps.md), D1–D4 |
| USDG usable as collateral | **Pass.** 6 dp, `permit`, static balances, USDG/USD feed 0.9996–1.0004. Risk: Paxos freeze/wipe | [01 §5](01-chain-facts.md#5-usdg), fork `UsdgPermit` |
| DEX depth for liquidations | **Pass for NVDA, marginal for SPY, fail for AAPL** vs the $250k-within-2% placeholder (Saturday: NVDA $1.26M, SPY $315k, AAPL $146k). Weekday check BLOCKED | [WS-C §6](../../sim/reports/phase0-weekend-gaps.md), [01 §6](01-chain-facts.md#6-dexs-and-aggregators-a8-rt-r3-or-r31) |
| Buffer adequacy | **Pass for weekends.** Upward 10y weekend gaps exceeded b_full (z 2.33) on 0–0.2% of weekends. **Not for earnings gaps:** NVDA +26% (2023-05-25) could exceed Morpho's 17.29% step at 77% LLTV | [WS-C §4](../../sim/reports/phase0-weekend-gaps.md), D5 |
| Weekend premium / liquidation profitability | **Pass.** Max sampled premium 2.46% vs break-even 8–16%; the "~12%" is not observed | [WS-C §5, §7](../../sim/reports/phase0-weekend-gaps.md) |
| Liquidator presence | **Pass (general).** 248 liquidations, 65 callers; none yet on stock-loan markets, so the fallback liquidator is required | [01 §8](01-chain-facts.md#8-liquidators) |
| EVM / toolchain (cancun) | **Pass** on Nitro | [01 §1](01-chain-facts.md#1-network) |
| Borrow demand | **Pending** (interviews). Weekend-arb demand alone is small | [WS-C §8](../../sim/reports/phase0-weekend-gaps.md), [05](05-interview-kit.md) |
| Lender appetite | **Pending** (interviews) | [05](05-interview-kit.md) |
| Legal characterization and issuer terms | **Pending** (counsel) | [06](06-legal-questions.md) |

## Open items

| Item | Owner |
|---|---|
| Approve or amend decisions D1–D6, D8, D9 (then I apply them to the PRD in a separate commit) | You |
| Archive `ROBINHOOD_RPC_URL` in `.env` and as a repo secret (pinned-block fork runs, weekday depth); explorer API key | You |
| 15 borrower + 10 lender interviews; perp-venue calls (Lighter, Arcus) | You |
| Questions A–D for counsel | Legal |
| Issuer: policy on blocking/burning DeFi contract balances; lending use under the terms; role key custody (MPC/multisig?) | You → Issuer |
| Chainlink: a sequencer uptime feed on chain 4663; post-mortem of the launch-week 1e18 answers | You → Chainlink (via Robinhood) |
| Morpho: Vault V2 deployment guidance on 4663, listing of our vaults | You → Morpho |
| Liquidator operators: support for stock-loan markets and `clUSDG` unwrap | You → operators |
| Litepaper / 00-overview "~12% premiums" claim: source it or remove it | You |

## Launch parameter suggestions (from WS-C; replace the placeholders in 10-risk-compliance)

| Param | SPY | NVDA | AAPL | Basis |
|---|---|---|---|---|
| σ_annual (buffer) | 17% | 52% | 28% | 5y realized (1y: 13% / 38% / 25%); use the higher until the sim says otherwise |
| z | 2.5 | 2.5 | 2.5 | 99.9% of 10y upward weekend gaps need z ≤ 2.35 |
| Closure hours | feed calendar (≈ 48 h weekend, 72 h 3-day) | same | same | D2 |
| b_full weekend (48 h, σ above, z 2.5) | 3.2% | 9.6% | 5.2% | computed |
| Overnight buffer | 0 (`overnightMode` on) | 0 | 0 | 24/5 feed, ≤ 0.7% overnight steps |
| Earnings-event buffer (D5) | none | ramp to ≥ 10% before the print | ramp to ≥ 8% | 10y close→open gaps |
| LLTV | 77% | 77% (+ event buffer) | 77% (+ event buffer) | Enabled onchain; D5 |
| `rSTOCK` supply cap at listing | $1M | $1M | **$250k** | Depth (D8) |
| Per-address cap | $75k | $250k | $35k | ≈ 25% of 2% depth; allowlist for larger MMs |
| DEX floor | off | off | off | Premiums ≪ break-even |
