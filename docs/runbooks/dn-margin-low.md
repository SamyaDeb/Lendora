# Runbook · USDG Earn venue margin low (`DN_MARGIN_LOW`, MON-R22, P0)

**Trigger.** The venue account's equity is below 2× maintenance margin (3× while the stock market is closed) (DN-R3,
08 weekend rule).

**Impact.** Below 1× the venue liquidates the shorts: the vault then holds unhedged spot and loses (at most) the margin
posted — 23.75% of NAV at `L = 3` (sim §4.3).

## First 5 minutes

1. Margin ratio: mock venue `marginRatio()`; Lighter via the NAV report (`nav-reporter` log) and the venue UI.
2. Cause: a sharp price rise (the short loses), negative funding, a venue mark diverging from Chainlink on a weekend.
3. `dn-rebalancer` health and log: it tops up from strategy cash, then the vault's cash above its 5% buffer, then by
   selling spot and buying back the same short (weekend: only below 1.5×).

## Fix

- Rebalancer running but blocked: the log says why (vault buffer, guard tripped → no spot sales). Guardian actions that
  are always available: `depositMargin` from strategy USDG, `unlend` + `sellSpot` + `adjustShort(+)` to raise USDG.
- Venue withdrawals/deposits halted: nothing onchain helps; pause entries (`vault.setDepositsPaused(true)`, guardian),
  keep exits open, and follow the venue's status. Loss is bounded by the margin share.
- After recovery: rerun the sim stress §4.1 with the actual move and report to the risk owner.
