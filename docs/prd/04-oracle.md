# 04 · Oracle adapter (weekend mode and guards)

**Phase 1.** `StocklineOracle` is a Morpho `IOracle` per market. It prices the stock from Chainlink, whose Stock Token
feeds already include the ERC-8056 multiplier (D1). When the feed is frozen (weekends, holidays) or ahead of a scheduled
event (earnings, D5) it marks the borrowed stock *up* by a volatility-scaled buffer. It never reverts, because a
reverting oracle would block liquidations.

## Scope

In: `StocklineOracle` (stock-loan markets), `ReceiptCollateralOracle` (`rSTOCK` collateral / USDG loan markets),
`MarketHours` (feed sessions and event windows), guard keeper, parameter sim.
Out: building a new price feed. Stockline consumes Chainlink.

## 1. Price math

Morpho's `price()` returns the value of 1 unit of **collateral** in units of **loan token**, scaled by
`1e36 · 10^(loanDecimals) / 10^(collateralDecimals)`.

For a stock-loan market (collateral `clUSDG`, loan `wNVDA`) (restated D1):

```
P_wrapped    = chainlink(NVDA/USD)                      // USD per raw token = per wrapped unit (LM-R1).
                                                        // The feed already applies the multiplier: never apply it again.
m            = wNVDA.multiplier()                        // ERC-8056, 1e18 = 1.0. Display (underlyingEquivalent) and guard input only
b(t)         = max(closure buffer, event buffer, guardian floor), 0 ≤ b ≤ B_MAX ≤ 20%   // section 3
P_eff        = P_wrapped * (1 + b(t))                    // borrowed stock marked UP while the feed is frozen or an event is due
V_coll       = clUSDG.valuePerToken() * chainlink(USDG/USD)   // USD per clUSDG (share price if vault-backed)

price()      = V_coll / P_eff  scaled to Morpho's 1e36 convention, one mulDiv, rounded down
```

With real decimals (feeds 8 dp, USDG and `clUSDG` 6 dp, Stock Tokens and wrappers 18 dp):
`price() = mulDiv(valuePerToken · usdgAnswer, 10^(36 + 18 − 6 + 8 − 8), stockAnswer · (1e18 + b))`.

For a receipt-collateral market (collateral `rNVDA`, loan USDG), the collateral is marked *down* (restated D1):

```
V_coll  = rNVDA.convertToAssets(1 share) * P_wrapped * (1 - b(t))     // P_wrapped = feed price, no multiplier
price() = V_coll / chainlink(USDG/USD)   scaled
```

| ID | Requirement |
|---|---|
| OR-R1 | `price()` implements the formulas above with full-precision `mulDiv` and a single rounding (down). `P_wrapped` is the Chainlink answer; the multiplier is never applied (D1). The formula lives in `packages/sdk` (`priceAt`); Solidity and SDK match **exactly** on ≥ 10k shared vectors (`contracts/test/vectors/`). |
| OR-R2 | `price()` never reverts on feed or guard conditions. A reverting feed, a zero or negative answer, or an answer rejected by OR-R7 is ignored: the last good answer is used and the guard trips (section 4). |
| OR-R3 | *(restated D1)* A multiplier change does not change `price()`. A multiplier change without an `oraclePaused()` window around it, or outside [0.1×, 10×], trips the guard (latched; cleared by the owner through the timelock). Changes of at most `maxQuietMultiplierStep` (5%, approved 2026-09-27, Q1) need no pause window, because Phase 0 saw dividend multiplier updates with no `oraclePaused()` window (01 §3.2–3.3); setting it to 0 restores the strict D1 rule (owner, timelock). Confirm procedure: [runbooks/multiplier-change.md](../runbooks/multiplier-change.md). |
| OR-R4 | A USDG/USD feed exists: `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2`, 8 decimals, 0.5% / 24h (verified Phase 0, 2026-09-26), so the feed is used, with the same last-good handling as the stock feed (OR-R2) and a sanity range of [$0.50, $2.00]. |
| OR-R5 | Oracle params (feeds, `B_MIN`, `B_MAX`, `z`, `σ`, ramp, heartbeat, sanity band, sequencer feed) are set at construction or by the owner through the 48h timelock. `B_MAX` can never exceed 20% (OR-R8). The guardian can only *raise* the buffer floor or trip the guard. |
| OR-R6 | *(new, D3)* Optional `sequencerUptimeFeed` (constructor/owner param; `address(0)` = disabled; none exists on chain 4663 today). If set, the guard trips while the feed reports the sequencer down and for a 1h grace period after it comes back. The guard keeper also trips the guard (`L2_GAP`) when consecutive L2 block timestamps jump by more than N minutes. `price()` never reverts. This pauses new borrows only; an oracle cannot delay liquidations after an outage, which the risk disclosure states. |
| OR-R7 | *(new, D4)* Sanity band. A round whose answer is ≤ 0, whose price is outside [$0.01, $1e6], or which is outside [×0.5, ×2] of the last good answer is ignored (the last good answer is kept) and trips the guard while it is the latest round. `poke()` advances the stored last good answer. After a genuine move of more than 2× between pokes, the owner (timelock) re-anchors the reference. Covers the launch-week incident (answers scaled 1e18 at 8 dp). |
| OR-R8 | *(new, D5)* Nothing Stockline controls moves `price()` down by more than Morpho's instant-drop bound in one block (1 − LLTV·LIF = 17.29% at LLTV 77%): buffer ramps, calendar pushes, guardian floor, parameter changes and multiplier changes. Enforced structurally: `B_MAX ≤ 20%` (a 0 → 20% step drops `price()` by 16.7%) and the multiplier never enters `price()`. Proved by a fuzz/property test. |

## 2. MarketHours

The oracle needs to know when the Chainlink feed is live, and when scheduled events are due. It must not depend on onchain
DST math.

| ID | Requirement |
|---|---|
| OR-R10 | *(restated D2, D5)* `MarketHours` stores an ordered list of **feed sessions** `{openTs, closeTs}` in UTC (the 24/5 feed runs Sunday 20:00 ET → Friday 20:00 ET, minus holidays), and per stock an ordered list of **event windows** `{stock, startTs, endTs, bufferWad}`. Views: `isOpen(t)`, `currentOrNextSession(t)`, `closureLength(t)`, `activeEvent(stock, t)`, `nextEvent(stock, t)`. |
| OR-R11 | *(restated D2)* Sessions and events are pushed in batches at least 14 days ahead by the owner (through the timelock). `packages/sdk/scripts/genSessions.ts` generates feed sessions from the NYSE holiday calendar: trading day D runs from D−1 20:00 ET to D 20:00 ET; weekends and holidays are frozen (Phase 0: no rounds on 2026-07-03; Labor Day 2026-09-07 rounds only from 20:00 ET); early-close days end at 17:00 ET (A9); DST is handled in TypeScript. Earnings windows come from the typed input `packages/sdk/data/events.json` (documented source). |
| OR-R12 | Failsafe: if `t` is past the last stored session, the market is treated as **closed** with `closureLength = MAX_CLOSURE` (96h), the guard trips (`CALENDAR`) and an alert fires. |
| OR-R13 | *(restated D2)* Chainlink Stock Token feeds are 24/5 (Sunday ~20:00 ET to Friday ~20:00 ET, including overnight) (verified Phase 0, 2026-09-26). `overnightMode` is **on**: `MarketHours` models feed sessions, so weeknights are not closures and the overnight buffer is 0. Closure hours for `b_full` come from the feed calendar (≈ 48h for a normal weekend, 72h for a 3-day weekend). |
| OR-R14 | *(new, D5)* Event windows. `endTs` is the earliest time a feed round can carry the event (the scheduled print); `startTs ≤ endTs` is when the event buffer must be fully in force. The buffer ramps in over `RAMP_IN` before `startTs`, holds, and is released on the first good round with `updatedAt ≥ endTs`, so the jump round and the release coincide, like the Monday open. Launch event buffers: NVDA ≥ 10%, AAPL ≥ 8%, SPY none. Setting `endTs` too late (a round after the print but before `endTs`) or too early (a pre-print round releases the buffer) loses the protection. Kept for launch (Q2, 2026-09-27); the anchored alternative is a sim task before mainnet parameters ([`sim/event_timing`](../../sim/event_timing/README.md)). |

## 3. Closure and event buffers

Buffer size scales with volatility and the length of the closure:

```
b_full = clamp( z · σ_annual · sqrt( closureHours / 8760 ), B_MIN, B_MAX )     // B_MAX ≤ 20% (OR-R8)
b(t)   = max( closure buffer(t), event buffer(t), guardianFloor )
```

Launch values (D8, from the GO-NO-GO memo; the sim replaces them): `z = 2.5`, `B_MIN = 1%`, `B_MAX = 20%`.

| Stock | σ_annual (5y) | Weekend (48h) b_full | 3-day weekend (72h) b_full | Event buffer (D5) |
|---|---|---|---|---|
| SPY | 17% | 3.1% | 3.9% | none |
| AAPL | 28% | 5.2% | 6.3% | ≥ 8% |
| NVDA | 52% | 9.6% | 11.8% | ≥ 10% |

**Ramp in.** A step change at the Friday 20:00 ET freeze would liquidate every position near the limit at once. The buffer
ramps linearly from 0 to `b_full` over `RAMP_IN = 4h` before the freeze (closures) or before `startTs` (events).
**Ramp out.** The buffer drops to 0 only on the first good Chainlink round with `updatedAt ≥ openTs` (closures) or
`≥ endTs` (events). It never drops on the clock alone. There is no overnight ramp (OR-R13).

| ID | Requirement |
|---|---|
| OR-R20 | *(restated D2, D5)* `bufferAt(t, lastGoodUpdatedAt)` implements ramp-in, hold and ramp-out-on-first-fresh-round for feed closures and event windows, takes the max with the guardian floor and clamps to `B_MAX`. It is a pure function of stored params, `MarketHours` and the last good round's `updatedAt`. |
| OR-R21 | `σ_annual` is a stored per-oracle param, updated at most weekly through the timelock from the sim's realized-vol output. |
| OR-R22 | *(restated D1)* The SDK exposes `priceAt` (feed price, never × multiplier), `bufferAt`, `liquidationPriceAt(position, t)` and `healthFactorAt(position, t)` so the app can show "your liquidation price after Friday 16:00 ET". It also generates the shared test vectors (OR-R1). |
| OR-R23 | *(restated D2, D5)* Tests cover: DST switch weeks, Good Friday, Thanksgiving (holiday plus 17:00 ET early close), a 3-day weekend, a holiday freeze on a weekday, a missed Sunday round and a missed Monday update (buffer stays on), the launch-week 1e18 incident, a 4:1 split with an `oraclePaused` window, an NVDA +26% earnings gap with the event buffer in force, and the OR-R8 property. |

## 4. Guards

A tripped guard pauses **new borrowing** by pulling free liquidity (see [03 §4](03-lending-markets.md)). It does not change
`price()` and never blocks liquidations.

| Guard (reason) | Trips when | Clears when |
|---|---|---|
| Staleness (`STALE`) | Session open and `now − max(updatedAt, sessionOpen) > heartbeat + 10 min` | Fresh good round |
| Sanity (`SANITY`, `USDG_FEED`) | Latest round rejected by OR-R7 / OR-R4, feed reverts, or USDG feed stale | Latest round accepted |
| Oracle pause (`ORACLE_PAUSED`, D4) | The Stock Token's `oraclePaused()` is true | Unpaused and a good round after the pause was last seen by `poke()` |
| Token pause (`TOKEN_PAUSED`, D4) | The Stock Token's `paused()` (per-token or global) is true | Unpaused |
| Wrapper blocked (`WRAPPER_BLOCKED`, D4) | The issuer registry reports `isBlocked(wrapper)` | Unblocked |
| Multiplier (`MULTIPLIER`, OR-R3) | Change without an `oraclePaused()` window (beyond the quiet step), or outside [0.1×, 10×] | Owner confirms through the timelock |
| Sequencer (`SEQUENCER`, OR-R6) | Uptime feed set and down, or up for less than 1h | Up for 1h |
| Calendar (`CALENDAR`, OR-R12) | `t` past the last stored session | Sessions pushed |
| Deviation (`DEVIATION`, keeper) | DEX 30-min TWAP differs from `P_wrapped` by more than `D_OPEN` (3%) when open, or `b_full + 3%` when closed | Keeper: under threshold for 30 continuous minutes |
| L2 gap (`L2_GAP`, keeper, OR-R6) | Consecutive L2 block timestamps jump by more than N minutes | Keeper or guardian |
| Manual (`MANUAL`) | Guardian calls `trip()` | Guardian calls `clear()` |

| ID | Requirement |
|---|---|
| OR-R30 | `guardTripped()` and `guardReasons()` (bitmask) are public views, evaluated live so they are right even if nobody has poked. `trip(reason)` / `clear(reason)` are callable by the guard keeper and the guardian for the offchain reasons (`DEVIATION`, `L2_GAP`, `MANUAL`). Every change emits `GuardChanged(reason, tripped)`. |
| OR-R31 | The guard keeper reads DEX pools listed in config. Stock Token liquidity sits mainly in Uniswap v3 0.05% pools against USDG and WETH (plus v4 pools and RFQ) (verified Phase 0, 2026-09-26); pool addresses in `packages/sdk/external-addresses.json`. It computes a 30-min TWAP (`observe`), trips within 1 block of a threshold breach, watches `oraclePaused`/`paused`/blocklist and L2 block-timestamp gaps. |
| OR-R32 | A permissionless `poke()` records the last good answers, latches or clears the onchain reasons and emits `GuardChanged`, so anyone can trip the staleness guard without trusting the keeper. |
| OR-R33 | While the guard is tripped, the app disables Borrow/Open short and shows the reason. Repay, add collateral and close short stay enabled. |

**DEX floor: off (D8).** A floor `max(P_eff, min(dexTwap, P_wrapped · 1.25))` would help liquidators when the token
trades far above the oracle. Phase 0 measured at most a 2.46% weekend premium (NVDA) against break-even premiums of
8–16% ([WS-C §5, §7](../../sim/reports/phase0-weekend-gaps.md)), and a floor would let a thin pool push `price()` down
(OR-R8). It stays off; any future floor must pass the sim and OR-R8.

## 5. Simulation deliverable (`/sim`)

- Inputs: 5+ years of daily and intraday prices for each launch stock; Stock Token onchain price history since launch; weekend and earnings gap distributions.
- Outputs per stock: `σ_annual`, `z`, ramp windows, event buffers, LLTV check, cap size such that 99.9% of simulated weekend gaps cause $0 bad debt given the liquidation incentive and DEX depth.
- The report is committed to `/sim/reports/` and linked from each parameter change proposal. Phase 0 first pass: [`phase0-weekend-gaps.md`](../../sim/reports/phase0-weekend-gaps.md).

## Acceptance criteria

- [x] Unit and fuzz tests for OR-R1…R8, OR-R20 and OR-R23 pass ([`StocklineOracle.t.sol`](../../contracts/test/oracle/StocklineOracle.t.sol), [`ReceiptCollateralOracle.t.sol`](../../contracts/test/oracle/ReceiptCollateralOracle.t.sol), [`MarketHours.t.sol`](../../contracts/test/MarketHours/MarketHours.t.sol)). The SDK and Solidity buffer and price outputs match exactly on 12k buffer vectors (real 2026–27 feed calendar incl. DST weeks and holidays), 12k price vectors and 9k receipt/b_full/health-factor vectors ([`OracleVectors.t.sol`](../../contracts/test/oracle/OracleVectors.t.sol), generated by [`genVectors.ts`](../../packages/sdk/scripts/genVectors.ts)). *Phase 1, 2026-09-27.*
- [x] Fork test: stale feed → guard trips → allocator pulls liquidity → new borrow fails → liquidation succeeds ([`test_phase1_exit_staleFeedPullsLiquidityButLiquidationWorks`](../../contracts/test/fork/phase1/Lifecycle.fork.t.sol)).
- [ ] Testnet runs through 2 real weekends with ramp-in, hold and ramp-out observed and logged.
- [ ] Sim report signed off by the risk owner before mainnet parameters are proposed.
