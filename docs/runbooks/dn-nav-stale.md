# Runbook · USDG Earn NAV stale (`DN_NAV_STALE`, MON-R23, P1)

**Trigger.** `NavOracle.fresh()` has been false for 5 minutes while the vault has deposits: no report within the max age
(15 min; DN-R5), a perp trade not yet reported (DN-R14), or a tripped oracle guard on a held sleeve.

**Impact.** No mint or burn: deposits, instant withdrawals and settlement wait. **Withdrawal requests and claims keep
working** (CP-R4). The app shows the "price data is being refreshed" state.

## First 5 minutes

1. `navOracle.reportAge()`, `lastReport().tradeNonce` vs `strategy.tradeNonce()`, each sleeve oracle's `guardReasons()`.
2. `nav-reporter` health/log: venue API reachable? signer (KMS) answering? gas?
3. A move above 1%, or single-signed moves adding up to more than 1% since the last co-signed report
   (`navOracle.unconfirmedMoveBps()`), needs the co-signer: is `nav-cosigner` up and agreeing (`422` = it disagrees
   with the report, `401` = token mismatch)?

## Fix

- Reporter down: restart; any allowed signer can sign a report, anyone can submit it.
- Co-signer refuses: its own venue read differs by more than 0.25% — investigate before overriding (a real disagreement
  is exactly what the second signer is for). Never add a signer to get a report through.
- Guard tripped on a stock: follow `guard-tripped.md`; the NAV returns when the guard clears.

## Co-signer independence (setup, not incident)

The co-signer is the second NAV key (DN-R4): it only protects anything if it is independent of the reporter.

- Its own host (a separate Railway project, or another provider), its own RPC endpoint and its own Lighter API
  credentials (`LIGHTER_API_URL` read with its own key when Lighter issues read keys).
- Its own signing key in its own KMS; never the reporter's key, never a key the operator holds.
- `COSIGNER_TOKEN` (≥ 32 chars) only in the two services' secret stores; the reporter reaches it over https (or the
  private `*.railway.internal` network) (OFF-18, OFF-21).
- Changing either NAV signer is a timelocked `setSigner` (48h).
