# Runbook · Guard tripped (`GUARD_TRIPPED` MON-R7, `PULL_NOT_EFFECTIVE` MON-R11, P1)

**Trigger.** Any oracle guard reason set (`GuardChanged(reason, true)` or live): `MANUAL`, `DEVIATION`, `L2_GAP`,
`STALE`, `SANITY`, `USDG_FEED`, `ORACLE_PAUSED`, `TOKEN_PAUSED`, `WRAPPER_BLOCKED`, `MULTIPLIER`, `SEQUENCER`,
`CALENDAR`. Subject `<ticker>:<reason>`; resolves on clear. `PULL_NOT_EFFECTIVE`: the guard is tripped and the vault
still has more than dust of free liquidity in the market 2 blocks later.

**Impact.** A trip by itself changes nothing for existing positions. It pauses **new borrowing by liquidity** (D6):
the allocator deallocates all free market liquidity within a block (LM-R31), and the router refuses `borrow` /
`openShort`. If the pull did not happen (`PULL_NOT_EFFECTIVE`), anyone can still borrow directly on Morpho.

## First 5 minutes

1. Which reason? `curl $MONITOR_URL/incidents | jq '.open[] | select(.rule=="GUARD_TRIPPED") | .subject'`, or
   `cast call $ORACLE "guardReasons()(uint256)"` (bits: 1 MANUAL, 2 DEVIATION, 4 L2_GAP, 8 STALE, 16 SANITY,
   32 USDG_FEED, 64 ORACLE_PAUSED, 128 TOKEN_PAUSED, 256 WRAPPER_BLOCKED, 512 MULTIPLIER, 1024 SEQUENCER, 2048 CALENDAR).
2. Verify the pull: free = `min(adapter expectedSupplyAssets, totalSupply − totalBorrow)` ≈ 0.
   `cast call $ADAPTER "expectedSupplyAssets(bytes32)(uint256)" $MARKET_ID`, `cast call $MORPHO "market(bytes32)(uint128,uint128,uint128,uint128,uint128,uint128)" $MARKET_ID`.
3. If not pulled: the **sentinel (guardian Safe) deallocates** the free amount (below), then check the allocator keeper
   ([keeper-down.md](keeper-down.md)).
4. Go to the reason's runbook: STALE/SANITY/USDG_FEED → [oracle-stale-or-rejected.md](oracle-stale-or-rejected.md);
   TOKEN_PAUSED/WRAPPER_BLOCKED/ORACLE_PAUSED → [issuer-pause-or-blocklist.md](issuer-pause-or-blocklist.md);
   MULTIPLIER → [multiplier-change.md](multiplier-change.md); L2_GAP/SEQUENCER → [sequencer-l2-gap.md](sequencer-l2-gap.md);
   CALENDAR → [calendar-push.md](calendar-push.md); DEVIATION → the DEX moved away from the feed (weekend premium,
   manipulation): wait for the keeper to clear it after 30 min under threshold.
5. MANUAL: find who tripped it (guardian Safe history) and why.

## Decision tree

- Onchain reasons clear themselves on `poke()` once the condition ends; keeper reasons (DEVIATION, L2_GAP) are cleared by
  the guard keeper; MANUAL only by the guardian.
- Keep MANUAL tripped until the incident behind it is resolved; then `clear(1)` and confirm the allocator re-allocates.

## Commands

```sh
cast calldata "trip(uint256)" 1                           # guardian Safe, to = $ORACLE (manual trip)
cast calldata "clear(uint256)" 1                          # guardian Safe, to = $ORACLE
cast calldata "deallocate(address,bytes,uint256)" $ADAPTER $MPDATA <free>   # sentinel = guardian Safe, to = $VAULT
cast send $ORACLE "poke()" --rpc-url $RPC --private-key $OPS_KEY          # sync onchain reasons (anyone)
```

Rehearsed on anvil: manual trip → allocator pull → borrow refused, repay works → clear (`runbooks.test.ts`), and the
monitor's trip / pull / clear pages (`monitor.test.ts`).

**Who signs.** Guardian 2-of-4 (trip, clear, sentinel deallocate). Keeper keys for DEVIATION / L2_GAP.

## Comms

> **Monitoring — new borrowing in NVDA is paused** (<UTC>): <reason in plain words>. Existing positions, repay, close
> and withdraw are unaffected. We will resume when <condition>.

## Post-mortem

- [ ] Time from trip to pull (target: 1 block); any direct Morpho borrows in between (`DIRECT_BORROW`)
- [ ] Whether the reason was real or a false positive; threshold tuning
