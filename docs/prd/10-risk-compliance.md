# 10 · Risk parameters, monitoring and compliance

Guarded mainnet launches with small caps, conservative LLTVs and a buffer tuned by simulation. Parameters below are
starting placeholders. The sim ([04 §5](04-oracle.md)) replaces them before proposals go on chain.

## Launch parameters

Launch values from the Phase 0 go/no-go memo (D8, [GO-NO-GO](../phase0/GO-NO-GO.md)); the sim replaces them before
mainnet proposals.

| Param | SPY | AAPL | NVDA | Where set |
|---|---|---|---|---|
| Stock-loan market LLTV | 77% | 77% (+ event buffer) | 77% (+ event buffer) | Morpho market (immutable) |
| `rSTOCK` supply cap (USD at listing) | $1M | **$250k** | $1M | Vault V2 absolute caps (in `wSTOCK` at the listing price) |
| `U_MAX` (utilization cap) | 90% | 90% | 90% | Vault V2 relative cap + allocator config |
| σ_annual (buffer) | 17% | 28% | 52% | Oracle (timelock); 5y realized |
| z | 2.5 | 2.5 | 2.5 | Oracle (timelock) |
| `B_MIN` / `B_MAX` | 1% / 20% | 1% / 20% | 1% / 20% | Oracle; `B_MAX` ≤ 20% hard limit (OR-R8) |
| Closure hours | feed calendar (≈ 48h weekend, 72h 3-day) | same | same | `MarketHours` (D2) |
| b_full weekend (48h) | 3.1% | 5.2% | 9.6% | computed |
| Ramp-in (closures and events) | 4h | 4h | 4h | Oracle |
| Overnight buffer | 0 (`overnightMode` on) | 0 | 0 | `MarketHours` feed sessions (D2) |
| Earnings event buffer | none | ≥ 8% | ≥ 10% | `MarketHours` event windows (D5) |
| Pre-earnings liquidity pull | no | yes | yes | Allocator (D5, LM-R31) |
| Sanity band (OR-R7) | ×0.5–×2, $0.01–$1e6 | same | same | Oracle |
| Deviation threshold open / closed | 3% / b+3% | 3% / b+3% | 3% / b+3% | Guard keeper |
| `HF_MIN_OPEN` (router) | 1.10 | 1.10 | 1.10 | Router |
| Per-address cap (debt, USD) | $75k | $35k | $250k | Router; allowlist for larger market makers (D8) |
| Global `clUSDG` cap | $4M total | | | Router |
| DEX floor | off | off | off | Oracle (D8) |
| Performance fee | 10% | 10% | 10% | Vault V2 → `FeeSplitter` |
| `rSTOCK` → USDG market LLTV | 62.5% | 62.5% | 62.5% | Morpho market, listed ≥ 30 days after launch |

Caps rise in steps (for example ×2) only after 2 weekends without a guard incident and a sim rerun. The AAPL cap
follows the Saturday 2% depth ($146k); re-measure on a weekday (BLOCKED on an archive RPC).

## Risk register

| Risk | Mitigation | Owner |
|---|---|---|
| Monday gap exceeds buffer → bad debt | Volatility-scaled buffer, ramp-in, caps sized by sim, backstop (Phase 5) | Risk |
| Earnings gap exceeds Morpho's 17.29% instant-drop bound (NVDA +26% in 10y) | Event buffers released with the jump round (D5, OR-R14), pre-earnings liquidity pull, caps; fall back to LLTV 62.5% if the sim says so | Risk |
| Weekend DEX premium makes liquidation unprofitable | Deviation guard pulls liquidity; fallback liquidator; optional DEX floor after sim | Risk |
| Short squeeze: lenders withdraw, utilization → 100%, rate spikes | Idle reserve (`U_MAX`), AdaptiveCurve rate spike forces covering, borrower alerts | Risk |
| Oracle stale or wrong (incl. the launch-week 1e18 answers) | Never-revert oracle, sanity band keeping the last good answer (OR-R7), staleness guard, permissionless `poke()` | Eng |
| Corporate action mishandled | Feed already includes the multiplier (D1), so `price()` ignores it; multiplier guard (OR-R3); manual guard trip before known events (splits) | Ops |
| Stock Token issuer blocklists or pauses the wrapper | Guard trips (D4) and liquidity is pulled; wrapped units and Morpho keep working; exits to the Stock Token wait for the issuer. Disclosed in terms | BD / Legal |
| Issuer `adminBurn` of the wrapper's backing | Cannot be prevented onchain (no pause/blocklist check). `backingShortfall()` P0 alert (LM-R8); per-market kill plan; issuer policy question (06 B2) | BD / Legal |
| Paxos freezes or wipes USDG at `clUSDG` or Morpho | Cannot be prevented; documented by fork test; disclosed; diversify backing later (CL-R7) | Legal |
| Sequencer outage | Optional uptime feed (OR-R6), keeper L2 gap detection pulls liquidity; liquidations after an outage cannot be delayed (disclosed) | Eng |
| Smart contract bug | Minimal custom code, Morpho unmodified, 2 audits, invariant tests, bug bounty, caps | Eng |
| Keeper failure | Health endpoints, paging, redundant instances, guardian manual actions | Eng |
| Regulatory (securities lending of tokenized equities) | Legal opinion per launch jurisdiction, geo-restrictions, no token | Legal |
| Perp venue failure (Phase 4) | Margin share limit, single-venue cap, sim stresses | Risk |

## Monitoring and paging

| Alert | Condition | Severity |
|---|---|---|
| Bad debt | Any `Liquidate` with `badDebtAssets > 0` | P0 |
| Missed liquidation | Position HF < 1.0 for > 2 blocks | P0 |
| Wrapper backing shortfall | `backingShortfall() > 0` on any `StockWrapper` (LM-R8) | P0 |
| Oracle stale while open | `now − max(updatedAt, sessionOpen) > heartbeat + 10 min` | P1 |
| Feed rejected by sanity band | `GuardChanged(SANITY or USDG_FEED, true)` | P1 |
| Guard tripped | Any `GuardChanged(tripped=true)` | P1 |
| Sequencer / L2 block gap | Uptime feed down, or consecutive L2 blocks > N minutes apart | P1 |
| Keeper down | No allocator run for 5 min | P1 |
| Utilization high | > 95% for 1h | P2 |
| MarketHours runway | < 7 days of sessions stored, or an earnings date within 30 days not yet pushed | P2 |
| Indexer lag | > 20 blocks | P2 |

Runbooks for each P0/P1 live in `/docs/runbooks/` and are drilled on testnet before mainnet.

## Compliance and access

| ID | Requirement |
|---|---|
| CP-R1 | Restricted: US, Canada, UK, Switzerland, UAE, plus OFAC-sanctioned jurisdictions. The list is config, not code. |
| CP-R2 | Web: edge geo-block on IP country, and a VPN/datacenter IP heuristic for borrow flows. |
| CP-R3 | Contracts: borrow and openShort need an EIP-712 attestation from the compliance signer (RT-R2), issued after an IP country check, a sanctions screen of the wallet (for example Chainalysis or TRM API) and terms acceptance. Validity 24h. |
| CP-R4 | Exits never require an attestation: repay, close, withdraw, unwrap. Users must always be able to leave. |
| CP-R5 | If Stock Tokens have issuer-level KYC or allowlists, Stockline relies on them and documents the dependency. There is no holder allowlist or KYC; the issuer has a blocklist, token and global pauses, and a forced burn (verified Phase 0, 2026-09-26). |
| CP-R6 | Legal opinions before mainnet on: whether stock lending of Stock Tokens is securities lending in target jurisdictions; whether `rSTOCK` or vault shares are securities; marketing restrictions. |
| CP-R7 | No yield or return promises in UI or marketing copy. APYs are labeled "variable, historical/current". |

## Audits and security

- 2 independent audits of Stockline contracts (wrapper, `clUSDG`, oracles, `MarketHours`, router, liquidator, splitter). Morpho Blue and Vault V2 are used unmodified from the audited, deployed releases. The delta-neutral vault gets a separate audit in Phase 4.
- A formal review of oracle math and buffer logic (OR-R1, OR-R20).
- Bug bounty live at mainnet (for example Immunefi), max payout sized to caps.
- Deployment via deterministic scripts; addresses verified on the explorer; multisig signers on hardware wallets.
