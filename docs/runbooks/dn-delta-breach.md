# Runbook · USDG Earn delta outside the band (`DN_DELTA_BREACH`, MON-R21, P1)

**Trigger.** A sleeve's |spot units − short units| is above 2% of its spot for 30 minutes (DN-R2). The rebalancer
normally realigns within a tick and once per US session.

**Impact.** The vault carries stock-price exposure on that sleeve: a 10% move with a 5% gap moves NAV by 0.5% of the
sleeve. No user action is blocked.

## First 5 minutes

1. `curl <dn-rebalancer>/health | jq` — is it running, and what is the last error? (`KEEPER_DOWN` would page too.)
2. Onchain: `strategy.spotUnits(i)`, `adapter.shortSize(market)` (mock) or the last NAV report's `shortSizes`.
3. Oracle guard on the stock (`guardReasons()`): swaps and the NAV need it clear; the rebalancer only trades the perp.
4. Venue: is the market trading? (Lighter status; weekend liquidity.)

## Fix

- Rebalancer healthy but failing: the log names the action (`align short …`). Price-limit or margin errors: top up margin
  first (`dn-margin-low.md`).
- Rebalancer down: the **guardian** can reduce a short (`adjustShort(i, +units, limit)`) or sell spot (`sellSpot`) by hand;
  only the operator can add a short. Restart the keeper, then watch one session alignment.
- Persisting > 2h with a healthy keeper: guardian `setPaused(true)` on the strategy (no new exposure) and escalate.

**Resolve.** The rule resolves when the band holds again. Record the drift and cause in the incident log.
