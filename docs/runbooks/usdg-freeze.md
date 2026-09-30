# Runbook · USDG freeze or wipe (`CLUSDG_BACKING`, MON-R4, P0)

**Trigger.** USDG balance of the `clUSDG` contract < `clUSDG.totalSupply()` (CL-R6). Cause: Paxos wiped USDG from the
`clUSDG` address. A **freeze** of the address does not change the balance, so it does not page this rule: it shows as
failing `clUSDG.unwrap` (liquidator bot errors, user reports) — handle it with this runbook too.

**Impact.** Wipe: `clUSDG` is under-backed; the last unwrappers lose. Freeze: nobody can unwrap `clUSDG`, so
liquidators receive collateral they cannot sell — liquidations stop being profitable, which puts lenders at risk.
Lendora cannot prevent either (CL-R5, disclosed; `CollateralTokenFreeze.fork.t.sol`).

## First 5 minutes

1. Confirm: `cast call $USDG "balanceOf(address)(uint256)" $CLUSDG` vs `cast call $CLUSDG "totalSupply()(uint256)"`;
   for a freeze, `cast call $CLUSDG "unwrap(uint256,address)" 1 <any holder> --from <holder>` reverts.
2. Guardian **trip(MANUAL) on every market** (all share `clUSDG`), allocator pulls; sentinel caps to 0.
3. Contact Paxos compliance (Legal owns); ask for the reason and whether it is address-specific.
4. Watch `MISSED_LIQUIDATION`: with a freeze, the fallback liquidator will refuse (it unwraps in the callback); be ready
   to liquidate and **hold** `clUSDG` to protect lenders ([missed-liquidation.md](missed-liquidation.md)).
5. Comms.

## Decision tree

- Freeze lifted within hours → clear guards once unwraps work and prices agree.
- Wipe, or a freeze that persists → wind down every market (delist, caps 0, guards tripped); v1.1 backing
  diversification (CL-R7) becomes a priority.

## Commands

```sh
for T in SPY NVDA AAPL; do echo "$T $(addr ".stocks.$T.oracle")"; done   # trip each: cast calldata "trip(uint256)" 1
pnpm --filter @lendora/sdk timelock router.setGlobalCap cap=0 --network $NET --salt "$(date -u +%F) global cap 0"
```

**Who signs.** Guardian 2-of-4 (trips, caps), owner via timelock (global cap, delist). Legal owns the Paxos contact.

## Comms

> **Investigating — USDG held by Lendora collateral was <frozen | removed> by the issuer (Paxos)** (<UTC>). New
> borrowing is paused on all markets. Repay keeps working; withdrawing collateral <works | is blocked by the freeze>.

## Post-mortem

- [ ] Paxos reason; sanctions exposure of the depositors (compliance screen logs, CP-R3)
- [ ] Loss allocation; backing diversification plan (CL-R7)
