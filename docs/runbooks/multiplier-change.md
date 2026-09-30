# Runbook · Multiplier change (`GUARD_TRIPPED` with `MULTIPLIER`, P1; OR-R3)

**Trigger.** The Stock Token's ERC-8056 `uiMultiplier()` changed without an `oraclePaused()` window around it and by
more than `maxQuietMultiplierStep` (5%, Q1 approved), or outside [0.1×, 10×]. The guard latches `MULTIPLIER` on the next
`poke()`; only the owner can clear it (`clearMultiplierGuard`, timelock).

**Impact.** `price()` does not use the multiplier (D1: the feed already includes it), so positions are priced
correctly as long as the Chainlink feed reflects the corporate action. The guard pauses new borrowing until someone
checks that the feed and the multiplier agree. Dividends (≤ 5%) never trip it.

## First 5 minutes

1. `cast call $STOCK "uiMultiplier()(uint256)"`, `newUIMultiplier()`, `effectiveAt()`; the issuer's corporate action
   notice (split ratio, dividend).
2. Compare the feed's answer before and after the change with the DEX price: the feed must reflect the split
   (price ÷ ratio) — Chainlink's answer is per token, multiplier included.
3. If the feed did **not** adjust: SANITY will also trip when it does (> 2×) — see
   [oracle-stale-or-rejected.md](oracle-stale-or-rejected.md) (re-anchor).
4. Guardian `raiseBufferFloor` if the feed and DEX disagree during the transition.
5. Owner schedules `clearMultiplierGuard` once feed and multiplier are consistent.

## Decision tree

- Announced split, feed adjusted consistently → schedule `clearMultiplierGuard` (48h) and communicate.
- Unannounced change / issuer error → contact the issuer; keep the guard until clarified.
- For a known upcoming split, trip `MANUAL` before it (10 risk register) and pre-schedule the confirm.

## Commands

```sh
cast send $ORACLE "poke()" --rpc-url $RPC --private-key $OPS_KEY
pnpm --filter @lendora/sdk timelock oracle.clearMultiplierGuard ticker=SPY --network $NET --salt "$(date -u +%F) SPY multiplier confirm"
```

Rehearsed on anvil: an unannounced +30% change latches `MULTIPLIER`; the confirm through the real timelock clears it
(`runbooks.test.ts`).

**Who signs.** Owner 4-of-7 via the timelock; guardian 2-of-4 for a floor raise or manual trip.

## Comms

> **Scheduled — NVDA <10-for-1 split> on <date>**: borrowing in NVDA pauses from <time> until the new price is
> confirmed (about 2 days). Positions are unaffected; balances in the app show both token and share amounts.

## Post-mortem

Only if it was unannounced or the feed lagged: issuer / Chainlink follow-up.
