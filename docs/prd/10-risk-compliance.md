# 10 · Risk parameters, monitoring and compliance

Guarded mainnet launches with small caps, conservative LLTVs and a buffer tuned by simulation. Parameters below are
starting placeholders. The sim ([04 §5](04-oracle.md)) replaces them before proposals go on chain.

## Launch parameters

| Param | SPY | AAPL | NVDA | Where set |
|---|---|---|---|---|
| Stock-loan market LLTV | 77% | 77% | 77% | Morpho market (immutable) |
| `rSTOCK` supply cap (USD at listing) | $2M | $1M | $1M | MetaMorpho cap |
| `U_MAX` (allocator utilization cap) | 90% | 90% | 90% | Allocator config |
| σ_annual (buffer) | 18% | 28% | 50% | Oracle (timelock) |
| `B_MIN` / `B_MAX` | 1% / 20% | 1% / 20% | 1% / 20% | Oracle |
| Ramp-in (weekend / overnight) | 4h / 1h | 4h / 1h | 4h / 1h | Oracle |
| Deviation threshold open / closed | 3% / b+3% | 3% / b+3% | 3% / b+3% | Guard keeper |
| `HF_MIN_OPEN` (router) | 1.10 | 1.10 | 1.10 | Router |
| Per-address collateral cap | $100k | $100k | $100k | Router |
| Global `clUSDG` cap | $4M total | | | `clUSDG` / router |
| `rSTOCK` → USDG market LLTV | 62.5% | 62.5% | 62.5% | Morpho market, listed ≥ 30 days after launch |

Caps rise in steps (for example ×2) only after 2 weekends without a guard incident and a sim rerun.

## Risk register

| Risk | Mitigation | Owner |
|---|---|---|
| Monday gap exceeds buffer → bad debt | Volatility-scaled buffer, ramp-in, caps sized by sim, backstop (Phase 5) | Risk |
| Weekend DEX premium makes liquidation unprofitable | Deviation guard pulls liquidity; fallback liquidator; optional DEX floor after sim | Risk |
| Short squeeze: lenders withdraw, utilization → 100%, rate spikes | Idle reserve (`U_MAX`), AdaptiveCurve rate spike forces covering, borrower alerts | Risk |
| Oracle stale or wrong | Never-revert oracle, staleness guard, permissionless `poke()`, multiplier bounds | Eng |
| Corporate action mishandled | Wrapper uses raw units; multiplier bound; manual guard trip before known events (splits) | Ops |
| Stock Token issuer freezes or blocklists the wrapper or Morpho | Phase 0 check with issuer; per-market kill plan; disclose in terms | BD / Legal |
| Smart contract bug | Minimal custom code, Morpho unmodified, 2 audits, invariant tests, bug bounty, caps | Eng |
| Keeper failure | Health endpoints, paging, redundant instances, guardian manual actions | Eng |
| Regulatory (securities lending of tokenized equities) | Legal opinion per launch jurisdiction, geo-restrictions, no token | Legal |
| Perp venue failure (Phase 4) | Margin share limit, single-venue cap, sim stresses | Risk |

## Monitoring and paging

| Alert | Condition | Severity |
|---|---|---|
| Bad debt | Any `Liquidate` with `badDebtAssets > 0` | P0 |
| Missed liquidation | Position HF < 1.0 for > 2 blocks | P0 |
| Oracle stale while open | `now − updatedAt > heartbeat + 10 min` | P1 |
| Guard tripped | Any `GuardChanged(tripped=true)` | P1 |
| Keeper down | No allocator run for 5 min | P1 |
| Utilization high | > 95% for 1h | P2 |
| MarketHours runway | < 7 days of sessions stored | P2 |
| Indexer lag | > 20 blocks | P2 |

Runbooks for each P0/P1 live in `/docs/runbooks/` and are drilled on testnet before mainnet.

## Compliance and access

| ID | Requirement |
|---|---|
| CP-R1 | Restricted: US, Canada, UK, Switzerland, UAE, plus OFAC-sanctioned jurisdictions. The list is config, not code. |
| CP-R2 | Web: edge geo-block on IP country, and a VPN/datacenter IP heuristic for borrow flows. |
| CP-R3 | Contracts: borrow and openShort need an EIP-712 attestation from the compliance signer (RT-R2), issued after an IP country check, a sanctions screen of the wallet (for example Chainalysis or TRM API) and terms acceptance. Validity 24h. |
| CP-R4 | Exits never require an attestation: repay, close, withdraw, unwrap. Users must always be able to leave. |
| CP-R5 | If Stock Tokens have issuer-level KYC or allowlists, Stockline relies on them and documents the dependency. [VERIFY] |
| CP-R6 | Legal opinions before mainnet on: whether stock lending of Stock Tokens is securities lending in target jurisdictions; whether `rSTOCK` or vault shares are securities; marketing restrictions. |
| CP-R7 | No yield or return promises in UI or marketing copy. APYs are labeled "variable, historical/current". |

## Audits and security

- 2 independent audits of Stockline contracts (wrapper, `clUSDG`, oracle, `MarketHours`, router, splitter). The vault gets a separate audit in Phase 4.
- A formal review of oracle math and buffer logic (OR-R1, OR-R20).
- Bug bounty live at mainnet (for example Immunefi), max payout sized to caps.
- Deployment via deterministic scripts; addresses verified on the explorer; multisig signers on hardware wallets.
