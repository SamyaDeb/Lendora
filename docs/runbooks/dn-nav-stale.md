# Runbook · USDG Earn NAV stale (`DN_NAV_STALE`, MON-R23, P1)

**Trigger.** `NavOracle.fresh()` has been false for 5 minutes while the vault has deposits: no report within the max age
(15 min; DN-R5), a perp trade not yet reported (DN-R14), or a tripped oracle guard on a held sleeve.

**Impact.** No mint or burn: deposits, instant withdrawals and settlement wait. **Withdrawal requests and claims keep
working** (CP-R4). The app shows the "price data is being refreshed" state.

## First 5 minutes

1. `navOracle.reportAge()`, `lastReport().tradeNonce` vs `strategy.tradeNonce()`, each sleeve oracle's `guardReasons()`.
2. `nav-reporter` health/log: venue API reachable? signer (KMS) answering? gas?
3. A move above 1% needs the co-signer: is `nav-cosigner` up and agreeing (`422` = it disagrees with the report)?

## Fix

- Reporter down: restart; any allowed signer can sign a report, anyone can submit it.
- Co-signer refuses: its own venue read differs by more than 0.25% — investigate before overriding (a real disagreement
  is exactly what the second signer is for). Never add a signer to get a report through.
- Guard tripped on a stock: follow `guard-tripped.md`; the NAV returns when the guard clears.
