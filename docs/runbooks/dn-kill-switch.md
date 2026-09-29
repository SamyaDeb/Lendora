# Runbook · USDG Earn sleeve killed (`DN_KILL_SWITCH`, MON-R25, P1)

**Trigger.** A sleeve was killed (the rebalancer's funding kill switch, DN-R7/DN-R13, or the guardian) and still holds
spot or a short: the unwind to USDG is in progress.

**Impact.** The sleeve earns nothing; its capital moves to USDG. User balances aren't affected beyond unwind costs;
the headline APY drops (the app shows the kill-switch state).

## First 5 minutes

1. Why: rebalancer log (`kill sleeve i (DN-R7)`) with the funding window, or the guardian's transaction.
2. Unwind progress: `strategy.spotUnits(i)`, the short size; spot sales wait for the session (08 weekend rule).
3. Funding data: Lighter `/api/v1/fundings` for the market; is the negative funding real and persistent?

## Fix

- Let the rebalancer finish; the rule resolves when spot and short are both 0.
- Reactivation is **not** automatic: a killed sleeve stays inactive. Re-adding it is an owner (timelock) action after
  the risk owner reviews funding (list a new sleeve or redeploy; there is no un-kill function by design).
