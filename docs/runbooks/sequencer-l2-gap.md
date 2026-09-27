# Runbook · Sequencer outage / L2 block gap (`L2_GAP`, MON-R8, P1)

**Trigger.** Consecutive Robinhood Chain block timestamps ≥ 5 min apart (normal: ~0.1 s). The guard keeper trips
`L2_GAP` on every oracle with the same detector (OR-R6); it clears 1h after the last gap. There is **no sequencer uptime
feed on chain 4663** (`sequencerFeed = address(0)` in every deploy config), so this keeper path is the active
mitigation (`keepers/test/guard.test.ts` L2-gap test; monitor test `MON_R8`).

**Impact.** During an outage nothing happens on chain. After it, the first blocks see a price jump if the market moved:
liquidations can fire immediately and cannot be delayed by the oracle (disclosed, OR-R6). New borrowing is paused by
the trip for 1h so nobody borrows against a stale view.

## First 5 minutes

1. Confirm on the explorer / `cast block latest`; check Robinhood Chain's status channel.
2. Confirm every market has `L2_GAP` (bit 4) set and liquidity was pulled.
3. Watch `MISSED_LIQUIDATION` and `BAD_DEBT` closely for the first 30 min after recovery.
4. Make sure keepers reconnected (`KEEPER_DOWN`).
5. Comms if the outage exceeded 15 min.

## Decision tree

- Short gap (< 15 min), no price move → let the keeper clear it after 1h.
- Long outage with a price move → keep the trip (guardian `trip(MANUAL)` to hold it beyond the keeper's hour) until
  liquidations have settled and DEX and feed agree.
- A sequencer uptime feed gets published on 4663 → owner sets it with `oracle.setSequencerFeed` (timelock) per market.

## Commands

```sh
cast block latest --field timestamp --rpc-url $RPC
cast calldata "trip(uint256)" 1       # guardian Safe, to = $ORACLE, hold the pause
cast calldata "clear(uint256)" 4      # guardian Safe: clear L2_GAP early if the keeper is down
pnpm --filter @stockline/sdk timelock oracle.setSequencerFeed ticker=NVDA feed=<feed> --network $NET --salt "<date> seq feed"
```

**Who signs.** Guard keeper (automatic), guardian 2-of-4 (manual hold / clear), owner via timelock (sequencer feed).

## Comms

> **Resolved — Robinhood Chain paused block production for <N> min** (<UTC>). New borrowing was paused for an hour
> afterwards as a precaution. Positions may have been liquidated if prices moved during the outage.

## Post-mortem

- [ ] Liquidations in the first 30 min after recovery, and whether any were caused only by the gap
