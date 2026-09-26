# 04 · Oracle adapter (weekend mode and guards)

**Phase 1.** `StocklineOracle` is a Morpho `IOracle` per market. It prices the stock from Chainlink and applies the ERC-8056
multiplier. When US markets are closed it marks the borrowed stock *up* by a volatility-scaled buffer. It never reverts,
because a reverting oracle would block liquidations.

## Scope

In: `StocklineOracle` (stock-loan markets), `ReceiptCollateralOracle` (`rSTOCK` collateral / USDG loan markets),
`MarketHours`, guard keeper, parameter sim.
Out: building a new price feed. Stockline consumes Chainlink.

## 1. Price math

Morpho's `price()` returns the value of 1 unit of **collateral** in units of **loan token**, scaled by
`1e36 · 10^(loanDecimals) / 10^(collateralDecimals)`.

For a stock-loan market (collateral `clUSDG`, loan `wNVDA`):

```
P_stock      = chainlink(NVDA/USD)                      // USD per share, feed decimals normalized to 1e18
m            = wNVDA.multiplier()                        // ERC-8056, 1e18 = 1.0
P_wrapped    = P_stock * m                               // USD per wrapped unit
b(t)         = weekend buffer, 0 ≤ b ≤ B_MAX             // section 3
P_eff        = P_wrapped * (1 + b(t))                    // borrowed stock marked UP when closed
V_coll       = clUSDG.valuePerToken() * chainlink(USDG/USD)   // USD per clUSDG (share price if vault-backed)

price()      = V_coll / P_eff  scaled to Morpho's 1e36 convention
```

For a receipt-collateral market (collateral `rNVDA`, loan USDG), the collateral is marked *down*:

```
V_coll  = rNVDA.convertToAssets(1 share) * P_wrapped * (1 - b(t))
price() = V_coll / chainlink(USDG/USD)   scaled
```

| ID | Requirement |
|---|---|
| OR-R1 | `price()` implements the formulas above with full-precision `mulDiv`. It is tested against a reference implementation in `packages/sdk` with fuzzed inputs; results match within 1 wei relative rounding. |
| OR-R2 | `price()` never reverts on a stale or zero Chainlink answer. It uses the last good answer and trips the guard (section 4). A zero or negative answer is ignored and the last good answer is used. |
| OR-R3 | A multiplier change is picked up in the same block. The multiplier is bounded per update (for example 0.1× to 10×) and an out-of-range jump trips the guard. |
| OR-R4 | USDG/USD is floored at 1.00 for collateral only if Phase 0 confirms no feed exists; otherwise the feed is used. [VERIFY] |
| OR-R5 | Oracle params (feeds, `B_MAX`, `z`, `σ`, ramp) are set at construction or by the owner through the 48h timelock. The guardian can only *raise* the buffer or trip the guard. |

## 2. MarketHours

The oracle needs to know whether US equity markets are open, including holidays and early closes. It must not depend on
onchain DST math.

| ID | Requirement |
|---|---|
| OR-R10 | `MarketHours` stores an ordered list of sessions `{openTs, closeTs}` in UTC. `isOpen(t)`, `currentOrNextSession(t)` and `closureLength(t)` are views. |
| OR-R11 | Sessions are pushed in batches at least 14 days ahead by the owner through the timelock. A script generates them from the NYSE calendar (holidays, 13:00 ET early closes, DST). |
| OR-R12 | Failsafe: if `t` is past the last stored session, the market is treated as **closed** with `closureLength = MAX_CLOSURE` (96h), and an alert fires. |
| OR-R13 | [VERIFY] If Chainlink publishes 24/5 prices for Stock Tokens, weeknight closures use a smaller or zero buffer (config `overnightMode`). |

## 3. Weekend buffer

Buffer size scales with volatility and the length of the closure:

```
b_full = clamp( z · σ_annual · sqrt( closureHours / 8760 ), B_MIN, B_MAX )
```

Launch defaults (to be tuned by sim): `z = 2.33` (99% one-sided), `B_MIN = 1%`, `B_MAX = 20%`.

| Stock | σ_annual (placeholder) | Weekend (65.5h) b_full | Overnight (17.5h) b_full |
|---|---|---|---|
| SPY | 18% | 3.6% | 1.9% |
| AAPL | 28% | 5.6% | 2.9% |
| NVDA | 50% | 10.1% | 5.2% |

**Ramp in.** A step change at Friday 16:00 ET would liquidate every position near the limit at once. The buffer ramps
linearly from 0 to `b_full` over `RAMP_IN` before close (4h for weekends and holidays, 1h for overnight).
**Ramp out.** At open, the buffer drops to 0 only after the first Chainlink update with `updatedAt ≥ openTs`. It never drops
on the clock alone.

| ID | Requirement |
|---|---|
| OR-R20 | `buffer(t)` implements ramp-in, hold during closure and ramp-out-on-first-fresh-price exactly as above. It is a pure function of stored params, `MarketHours` and feed `updatedAt`. |
| OR-R21 | `σ_annual` is a stored per-oracle param, updated at most weekly through the timelock from the sim's realized-vol output. |
| OR-R22 | The SDK exposes `bufferAt(t)` and `liquidationPriceAt(position, t)` so the app can show "your liquidation price after Friday 12:00 ET". |
| OR-R23 | Tests cover: DST switch weeks, Good Friday, Thanksgiving early close, a 3-day weekend, a missed Monday update (buffer stays on). |

## 4. Staleness and deviation guards

A tripped guard pauses **new borrowing** by pulling free liquidity (see [03 §4](03-lending-markets.md)). It does not change
`price()` and never blocks liquidations.

| Guard | Trips when | Clears when |
|---|---|---|
| Staleness | Market open and `now − updatedAt > heartbeat + 10 min` | Fresh update received |
| Deviation | DEX 30-min TWAP differs from `P_wrapped` by more than `D_OPEN` (3%) when open, or `b_full + 3%` when closed | Deviation under the threshold for 30 continuous minutes |
| Multiplier jump | Multiplier change outside bounds (OR-R3) | Owner confirms through the timelock |
| Manual | Guardian calls `trip()` | Guardian calls `clear()` |

| ID | Requirement |
|---|---|
| OR-R30 | `guardTripped()` is a public view. `trip(reason)` / `clear()` are callable by the guard keeper and the guardian. Every change emits `GuardChanged(reason, tripped)`. |
| OR-R31 | The guard keeper reads DEX pools listed in config. [VERIFY] which DEXs hold Stock Token liquidity. It computes a TWAP and trips within 1 block of threshold breach. |
| OR-R32 | The staleness guard is also checked onchain in a permissionless `poke()`, so anyone can trip it without trusting the keeper. |
| OR-R33 | While the guard is tripped, the app disables Borrow/Open short and shows the reason. Repay, add collateral and close short stay enabled. |

**Optional DEX floor (default off).** When the token trades far above the oracle (the documented ~12% weekend premium),
liquidators must buy `wNVDA` above oracle value, and the 7.4% incentive may not cover it. Option `dexFloorEnabled` would use
`max(P_eff, min(dexTwap, P_wrapped · 1.25))`. It stays off until the sim shows the manipulation cost exceeds the gain at caps.

## 5. Simulation deliverable (`/sim`)

- Inputs: 5+ years of daily and intraday prices for each launch stock; Stock Token onchain price history since launch; weekend gap distribution.
- Outputs per stock: `σ_annual`, `z`, ramp windows, LLTV check, cap size such that 99.9% of simulated weekend gaps cause $0 bad debt given the liquidation incentive and DEX depth.
- The report is committed to `/sim/reports/` and linked from each parameter change proposal.

## Acceptance criteria

- [ ] Unit and fuzz tests for OR-R1, OR-R20 and OR-R23 pass. The SDK and Solidity buffer outputs match on 10k fuzzed timestamps.
- [ ] Fork test: stale feed → guard trips → allocator pulls liquidity → new borrow fails → liquidation succeeds.
- [ ] Testnet runs through 2 real weekends with ramp-in, hold and ramp-out observed and logged.
- [ ] Sim report signed off by the risk owner before mainnet parameters are proposed.
