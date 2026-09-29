# Runbook · USDG Earn withdrawal queue overdue (`DN_QUEUE_OVERDUE`, MON-R24, P0)

**Trigger.** The oldest queued withdrawal request is past its promised settlement (72h or the next US open, whichever
is later; DN-R1).

**Impact.** A promise to users is broken. While overdue the strategy cannot take cash from the vault
(`QueueOverdue`), so all idle cash goes to exits.

## First 5 minutes

1. `vault.queueBounds()`, `request(head)` (shares, settleBy), `idleAssets()`, `navOracle.fresh()`, `marketOpen()`.
2. `dn-rebalancer` log: it reduces every sleeve pro rata, reclaims margin and returns cash, then settles.
3. Blockers: stale NAV (`dn-nav-stale.md`), closed session (settles at the next open), venue withdrawal halt, rSTOCK
   utilization at 100% (lent spot not redeemable; sim §4.4).

## Fix

- Anyone can call `vault.settle(n)` once the NAV is fresh and idle covers the head.
- Guardian manual unwind: `unlend`, `sellSpot`, `adjustShort(+)`, `requestMarginWithdraw`, `claimMargin`,
  `returnToVault`, then `settle`.
- rSTOCK illiquid: redeem what the vault's idle allows and wait for the allocator/borrowers; communicate the delay.
- Post-incident: publish the delay and cause; review `LEND_RATIO` (DN-R8) with the risk owner.
