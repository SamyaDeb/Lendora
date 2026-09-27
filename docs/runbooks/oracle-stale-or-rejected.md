# Runbook · Oracle stale or feed rejected (`ORACLE_STALE` MON-R5, `FEED_REJECTED` MON-R6, P1)

**Trigger.** `ORACLE_STALE`: the feed session is open and `now − max(updatedAt, sessionOpen) > heartbeat + 10 min` on
the raw Chainlink round. `FEED_REJECTED`: the oracle's `SANITY` (stock round ≤ 0, outside $0.01–$1e6, or outside
×0.5–×2 of the last good answer, OR-R7) or `USDG_FEED` (USDG round rejected or stale) reason is set. Both also appear as
`GUARD_TRIPPED` for the same reason.

**Impact.** `price()` never reverts and keeps the last good answer (OR-R2), so existing positions and liquidations keep
working at that price. New borrows are blocked by the guard, and the allocator pulls liquidity (LM-R31). Risk: if the
real price moves while the oracle is frozen, liquidations lag reality.

## First 5 minutes

1. Read the raw feed and the oracle: `cast call $FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)"`,
   `cast call $ORACLE "stockAnswer()(uint256,uint256)"`, `cast call $ORACLE "guardReasons()(uint256)"`.
2. Is it market-wide? Check the other markets and Chainlink's status page / the feed's other consumers.
3. Confirm the allocator pulled: `PULL_NOT_EFFECTIVE` must not be open ([guard-tripped.md](guard-tripped.md)).
4. Compare with the DEX TWAP (guard keeper logs `deviation`).
5. Comms only if it lasts > 1h during US hours.

## Decision tree

- **Stale, Chainlink incident** → wait; the guard clears on the first good round. If > 4h during an open session and the
  DEX moves > 5%, guardian `raiseBufferFloor` to protect lenders (it can only raise; lowering is owner via timelock).
- **Rejected, a bad round** (e.g. the launch-week 1e18 scaling) → wait for correct rounds; nothing to do onchain; tell
  Chainlink.
- **Rejected, a genuine move > 2× between pokes** (A13: split without the multiplier path, or a crash while nobody
  poked) → verify the new price against the DEX and news, then the owner **re-anchors** with `resetReferences`
  through the timelock (48h; the guard blocks new borrows meanwhile). Rehearsed: `runbooks.test.ts`.
- **USDG_FEED** → the USDG/USD feed is stale or off-peg: if USDG really depegs, trip every market manually.

## Commands

```sh
cast send $ORACLE "poke()" --rpc-url $RPC --private-key $OPS_KEY          # anyone: record the latest round, sync reasons
cast calldata "raiseBufferFloor(uint256)" 50000000000000000              # guardian Safe, to = $ORACLE (5%)
pnpm --filter @stockline/sdk timelock oracle.resetReferences ticker=NVDA --network $NET --salt "$(date -u +%F) NVDA re-anchor"
pnpm --filter @stockline/sdk timelock oracle.setBufferFloor ticker=NVDA floorWad=0 --network $NET --salt "$(date -u +%F) NVDA floor 0"
```

**Who signs.** Anyone for `poke`; guardian 2-of-4 for the floor raise; owner 4-of-7 via timelock for re-anchor and
lowering the floor.

## Comms

> **Monitoring — NVDA price feed <delayed | rejected an out-of-range update>** (<UTC>). Stockline keeps using the last
> good price; new borrowing in NVDA is paused until the feed is healthy. Repay, close and withdraw work.

## Post-mortem

- [ ] Duration, cause (Chainlink, corporate action, bug), max DEX deviation while frozen
- [ ] Whether A13 (owner-only re-anchor) was too slow; consider a guardian re-anchor path
