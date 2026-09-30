# Runbook · Issuer pause or blocklist (`GUARD_TRIPPED` with `TOKEN_PAUSED`, `WRAPPER_BLOCKED` or `ORACLE_PAUSED`, P1)

**Trigger.** The Stock Token issuer paused the token (per-token or global `paused()`), blocklisted the wrapper
(`isBlocked(wrapper)` on the issuer registry), or raised `oraclePaused()` (corporate action window). The oracle's guard
trips with the matching reason (D4).

**Impact (A25).** While the token is paused or the wrapper is blocked, anything that moves the Stock Token reverts in
the token itself: `repay`, `closeShort`, `withdrawLend`, `unwrap`, and liquidations that need to buy/unwrap the stock.
USDG-side exits keep working: `withdrawCollateral` while healthy, `clUSDG.unwrap`. `wSTOCK` and Morpho keep working
(liquidators holding `wSTOCK` can still liquidate). `oraclePaused` alone blocks nothing; it guards a multiplier change.

## First 5 minutes

1. Which flag? `cast call $STOCK "paused()(bool)"`, `cast call $STOCK "oraclePaused()(bool)"`,
   `cast call <registry> "isBlocked(address)(bool)" $WRAPPER` (registry = `ACCESS_CONTROLLED_REGISTRY()` on the token).
2. Check it is issuer-wide (other Stock Tokens paused too?) and the issuer's announcements.
3. Confirm the allocator pulled ([guard-tripped.md](guard-tripped.md)).
4. Guardian `raiseBufferFloor` if the pause spans a price-moving event (no fresh rounds while paused).
5. Comms (users will see failed repays).

## Decision tree

- `oraclePaused` (announced corporate action) → expected; the multiplier path handles it
  ([multiplier-change.md](multiplier-change.md)). Nothing to do.
- Token/global pause, short (< 1 day) → wait; the guard clears on `poke()` after unpause.
- Wrapper blocklisted → contact the issuer (BD/Legal) at once; the market cannot function; start the wind-down
  (delist, cap 0) if not reversed within 24h.
- Pause lasting through liquidations → positions going under cannot be closed by users; the fallback liquidator with a
  `wSTOCK` inventory can still liquidate; coordinate with liquidators.

## Commands

```sh
cast send $ORACLE "poke()" --rpc-url $RPC --private-key $OPS_KEY          # after unpause: clear TOKEN_PAUSED
cast calldata "raiseBufferFloor(uint256)" <wad>                          # guardian Safe, to = $ORACLE
pnpm --filter @lendora/sdk timelock router.delistMarket ticker=NVDA --network $NET --salt "$(date -u +%F) NVDA blocklist delist"
```

Rehearsed on anvil: issuer pause → guard `TOKEN_PAUSED` → `withdrawCollateral` (USDG side) works → unpause → cleared
(`runbooks.test.ts`).

**Who signs.** Guardian 2-of-4 (floor), owner via timelock (delist). BD/Legal own the issuer relationship.

## Comms

> **Identified — the NVDA Stock Token issuer has <paused transfers | restricted the Lendora wrapper>** (<UTC>).
> Repaying or closing NVDA positions needs NVDA transfers and waits for the issuer. Withdrawing USDG collateral from
> healthy positions works. New borrowing is paused.

## Post-mortem

- [ ] Issuer reason and notice given; terms disclosure (CP-R5)
- [ ] Positions that went unhealthy during the pause and how they were resolved
