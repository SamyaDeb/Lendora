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
follows the Saturday 2% depth ($146k across both pools); a Sunday rerun (2026-09-27) is within 2% on the binding
USDG pool, so caps are unchanged. **Weekday rerun done (Phase 3 task 8, 2026-09-28):** SPY and AAPL within ±8% of
the weekends; **NVDA push-up depth −47% / −37% ⚑** (flagged to the owner, caps unchanged;
[WS-C §6](../../sim/reports/phase0-weekend-gaps.md)). The mainnet sim ([mainnet-params.md](../../sim/reports/mainnet-params.md))
keeps every launch value and flags: the full D8 cap targets for SPY ($323k) and AAPL ($147k) fail the 99.9% $0-bad-debt
test on today's depth (launch caps at 25% pass), and NVDA's per-address cap would be $166k on weekday depth.

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
| Soft-gate residual (05 §1): Morpho borrowing is permissionless, so a once-attested borrower (rescue top-up), a debt-free `clUSDG` holder in Morpho, or a liquidator holding seized `clUSDG` can borrow directly on Morpho without a fresh attestation and beyond the per-address cap | Hard limit = vault caps, idle reserve and allocator pulls (03 §4); new collateral only via attested entries (RT-R8); `DIRECT_BORROW` alert (MON-R10) and the geo/sanctions review on the offending address; disclosed as an audit known issue | Eng / Compliance |
| Smart contract bug | Minimal custom code, Morpho unmodified, 2 audits, invariant tests, bug bounty, caps | Eng |
| Keeper failure | Health endpoints, paging, redundant instances, guardian manual actions | Eng |
| Regulatory (securities lending of tokenized equities) | Legal opinion per launch jurisdiction, geo-restrictions, no token | Legal |
| Perp venue failure (Phase 4) | Margin share limit, single-venue cap, sim stresses | Risk |

## Monitoring and paging

Implemented by the ops monitor `keepers/src/monitor/` (remediation task 3; MON-R16…R20 Phase 3 task 5): read-only, restart-safe (incidents, duration
watches, event cursor and the weekend log live in Postgres), deduped by `(rule, subject)` with re-notification (P0
15 min, P1 1h, P2 6h) and a resolve notification. Pagers: PagerDuty Events v2, Opsgenie, Telegram, signed webhook.
Tests: [`keepers/test/monitor.test.ts`](../../keepers/test/monitor.test.ts) (each rule fires once and resolves once on
anvil from real chain conditions).

| ID | Rule | Condition | Sev | Runbook |
|---|---|---|---|---|
| MON-R1 | `BAD_DEBT` | Morpho `Liquidate` with `badDebtAssets > 0` on a Stockline market | P0 | [bad-debt](../runbooks/bad-debt.md) |
| MON-R2 | `MISSED_LIQUIDATION` | Any position HF < 1.0 for > 2 blocks (SDK `healthFactorAt`, positions from the indexer) | P0 | [missed-liquidation](../runbooks/missed-liquidation.md) |
| MON-R3 | `BACKING_SHORTFALL` | `backingShortfall() > 0` on any `StockWrapper` (LM-R8), every tick | P0 | [wrapper-backing-shortfall](../runbooks/wrapper-backing-shortfall.md) |
| MON-R4 | `CLUSDG_BACKING` | USDG balance of `clUSDG` < `totalSupply` (CL-R6; Paxos freeze/wipe) | P0 | [usdg-freeze](../runbooks/usdg-freeze.md) |
| MON-R5 | `ORACLE_STALE` | Open session and `now − max(updatedAt, sessionOpen) > heartbeat + 10 min` (raw feed) | P1 | [oracle-stale-or-rejected](../runbooks/oracle-stale-or-rejected.md) |
| MON-R6 | `FEED_REJECTED` | `GuardChanged(SANITY or USDG_FEED, true)`, or those reasons live | P1 | [oracle-stale-or-rejected](../runbooks/oracle-stale-or-rejected.md) |
| MON-R7 | `GUARD_TRIPPED` | Any `GuardChanged(tripped = true)` or reason live; resolves on clear (a trip and clear between ticks still pages) | P1 | [guard-tripped](../runbooks/guard-tripped.md) |
| MON-R8 | `L2_GAP` | Consecutive block timestamps ≥ N min apart (the guard keeper's detector, shared) | P1 | [sequencer-l2-gap](../runbooks/sequencer-l2-gap.md) |
| MON-R9 | `KEEPER_DOWN` | Allocator/guard/liquidator/alerts `/health` not 200 (the allocator's turns 503 after 5 min without a run, LM-R33) | P1 | [keeper-down](../runbooks/keeper-down.md) |
| MON-R10 | `DIRECT_BORROW` | Morpho `Borrow` on a Stockline market whose `caller` is not the router (05 §1 residual, RT-R8) | P1 | [direct-borrow](../runbooks/direct-borrow.md) |
| MON-R11 | `PULL_NOT_EFFECTIVE` | Guard tripped and vault free market liquidity > dust (the allocator's 1e15 minimum move) after 2 blocks (LM-R31) | P1 | [guard-tripped](../runbooks/guard-tripped.md) |
| MON-R12 | `UTILIZATION_HIGH` | Vault-level utilization > 95% for 1h | P2 | – |
| MON-R13 | `CALENDAR_RUNWAY` | < 7 days of sessions stored, or an earnings window within 30 days not pushed | P2 | [calendar-push](../runbooks/calendar-push.md) |
| MON-R14 | `INDEXER_LAG` | Indexed head > 20 blocks behind, or an SI-R5 reconciliation diff (run inside the monitor) | P2 | [keeper-down](../runbooks/keeper-down.md) |
| MON-R15 | `LOW_GAS` / `LOW_GAS_CRITICAL` | A keeper signer's ETH lasts < 3 days (P1) / < 1 day (P0) at max(configured `GAS_BURN_WEI_PER_DAY`, burn measured over the last day, ≥ 1h window; a top-up restarts it) | P1 / P0 | [low-gas](../runbooks/low-gas.md) |
| MON-R16 | `TIMELOCK_SCHEDULED` | Any `CallScheduled` / `Cancelled` on the Stockline `TimelockController`, or a Vault V2 curator `Submit` / `Revoke`; the call decoded by the SDK (`decodeStocklineCall`) in the page. Auto-resolves after 72h | P1 | [governance-change](../runbooks/governance-change.md) |
| MON-R17 | `TIMELOCK_EXECUTED` / `TIMELOCK_EXECUTED_UNTRACKED` | `CallExecuted` / vault `Accept`; **P0** (`_UNTRACKED`) when the monitor never saw the matching schedule (nobody had the delay to react). Auto-resolves after 24h | P1 / P0 | [governance-change](../runbooks/governance-change.md) |
| MON-R18 | `ROLE_CHANGED` | Ownership, curator, sentinel, allocator, oracle guardian/keeper, attestation signer, router implementation, converter keeper/destination, fee recipients, timelock roles or min delay change on any Stockline contract | P0 | [governance-change](../runbooks/governance-change.md) |
| MON-R19 | `LIQUIDATION_UNPROFITABLE` | A position with HF < 1 whose seized collateral (debt × LIF at the oracle price) buys less than the debt on the best DEX route now (mock aggregator on anvil/testnet, Uniswap v3 QuoterV2 on 4663) | P1 | [missed-liquidation](../runbooks/missed-liquidation.md) |
| MON-R20 | `FEE_NOT_DISTRIBUTED` | `rSTOCK` fee shares worth > $1k (oracle value) in the `FeeSplitter` or a `FeeConverter` for > 8 days (FE-R4) | P2 | [keeper-down](../runbooks/keeper-down.md) |

**Weekend log.** For every closure ≥ 24h and every market the monitor records, once, the ramp-in start, full buffer,
close, first fresh round and ramp-out, plus guard trips/clears from the ramp start to 24h after the reopen, and serves
them at `GET /weekends` with a `clean` verdict (all milestones seen, no guard trip, no P0/P1 incident). This is the
evidence for the Phase 2 exit "2 clean testnet weekends".

Runbooks for each P0/P1 live in `/docs/runbooks/` and are drilled on testnet before mainnet.

## Compliance and access

| ID | Requirement |
|---|---|
| CP-R1 | Restricted: US, Canada, UK, Switzerland, UAE, plus OFAC-sanctioned jurisdictions. The list is config, not code. |
| CP-R2 | Web: edge geo-block on IP country, and a VPN/datacenter IP heuristic for borrow flows. |
| CP-R3 | Contracts: borrow and openShort need an EIP-712 attestation from the compliance signer (RT-R2), issued after an IP country check, a sanctions screen of the wallet (for example Chainalysis or TRM API) and terms acceptance. Validity 24h. *(Phase 3 task 6)* Chainalysis and TRM adapters behind one interface (`compliance/src/sanctions/`, `SANCTIONS_PROVIDER`), block rules A36; timeouts, HTTP errors and unexpected bodies fail the attestation closed and never touch exits. Tests: `CP_R3_*` in [`sanctions.test.ts`](../../compliance/test/sanctions.test.ts) (fake HTTP server, no real API calls). |
| CP-R4 | Exits never require an attestation: repay, close, withdraw, unwrap. Users must always be able to leave. |
| CP-R5 | If Stock Tokens have issuer-level KYC or allowlists, Stockline relies on them and documents the dependency. There is no holder allowlist or KYC; the issuer has a blocklist, token and global pauses, and a forced burn (verified Phase 0, 2026-09-26). |
| CP-R6 | Legal opinions before mainnet on: whether stock lending of Stock Tokens is securities lending in target jurisdictions; whether `rSTOCK` or vault shares are securities; marketing restrictions. |
| CP-R7 | No yield or return promises in UI or marketing copy. APYs are labeled "variable, historical/current". |
| CP-R8 | *(new, remediation 2026-09-27)* Geo and client-IP headers are trusted only from the web app's server-side proxy. The compliance service refuses to start on any network except local anvil (31337) without `PROXY_SECRET` (≥ 32 chars), or with `TRUST_PROXY=true` and no secret, and on mainnet (4663) with the deny-list sanctions adapter, an unknown `SANCTIONS_PROVIDER`, a missing `SANCTIONS_API_KEY` or a plain-http `SANCTIONS_API_URL`; it logs the provider at startup and names it on `/health`. The web proxy forwards only the configured edge platform's geo/IP headers (`GEO_PLATFORM`), normalized, and drops every client-sent geo, `x-forwarded-for` and `x-stockline-proxy` header. `/attest` is rate-limited per IP and per wallet. Tests: `CP_R8_*` in [`compliance.test.ts`](../../compliance/test/compliance.test.ts) and [`complianceProxy.test.ts`](../../web/test/complianceProxy.test.ts). |

## Audits and security

- 2 independent audits of Stockline contracts (wrapper, `clUSDG`, oracles, `MarketHours`, router, liquidator, splitter). Morpho Blue and Vault V2 are used unmodified from the audited, deployed releases. The delta-neutral vault gets a separate audit in Phase 4.
- A formal review of oracle math and buffer logic (OR-R1, OR-R20).
- Bug bounty live at mainnet (for example Immunefi), max payout sized to caps.
- Deployment via deterministic scripts; addresses verified on the explorer; multisig signers on hardware wallets.

## Mainnet readiness (MN-R*, Phase 3)

| ID | Requirement | Evidence |
|---|---|---|
| MN-R1 | *(Phase 3 task 7)* The mainnet deploy refuses any role that is `address(0)`, a `stockline.placeholder.*` address, the deployer, or equal to another role: all nine `STOCKLINE_*` roles (owner, curator, guardian, allocator, guard keeper, treasury, `BackstopReserve`, fee keeper, attestation signer) are distinct (A27 does not carry over). | `test_MN_R1_*` in [`DeployMainnet.t.sol`](../../contracts/test/deploy/DeployMainnet.t.sol) |
| MN-R2 | The five multisig roles are deployed contracts with Safe thresholds: owner ≥ 4-of-7, guardian ≥ 2-of-4, curator, treasury and `BackstopReserve` ≥ 2 (an EOA-looking placeholder is refused, Q9). | `test_MN_R2_*` |
| MN-R3 | Launch parameters are enforced by the script: 48h timelock, `sequencerFeed = address(0)`, $4M global `clUSDG` cap, UniversalRouter in `Transfer` mode (Q4), vault caps at exactly 25% of the D8 targets, per-address caps from the launch table. | `test_MN_R3_*` |
| MN-R4 | `DeployMainnet` runs only on chain 4663 and only with `I_HAVE_THE_OWNERS_GO=1`; no session sets it without the owner's written go in the launch log. | `test_MN_R4_*` |
| MN-R5 | `VerifyRoles` (read-only) checks every mainnet-launch §3.4 item plus the Vault V2 code (official factory byte-identical to the pinned source, `isVaultV2`, vault runtime equal to the pinned `VaultV2` outside immutables) and prints a pass/fail table; the Phase 1 lifecycle runs against the deployed config. | `test_MN_R5_*` (anvil) and [`DeployMainnet.fork.t.sol`](../../contracts/test/fork/phase3/DeployMainnet.fork.t.sol) (4663 fork at `latest`) |

