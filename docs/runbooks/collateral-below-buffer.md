# Runbook · Collateral withdrawn below the 24h buffer (`COLLATERAL_BELOW_BUFFER`, MON-R26, P2)

**Trigger.** A Morpho `WithdrawCollateral` on a Lendora market, either through the router (`CollateralWithdrawn`,
`path: router`) or directly on Morpho (`path: direct`), left a position that still has debt with **HF < 1.10 at
t + 24h**. That is the RT-R1 weekend/earnings buffer every entry must meet. Subject `<ticker>:<borrower>`. It is a
state rule: re-evaluated every tick on the position as it is now, and it resolves when HF(t + 24h) is back at 1.10 or
above, or the debt is gone. This is residual (e) in [05 §1](../prd/05-collateral-router.md) (T10). The router has no
buffer check on exits, and Morpho allows any withdrawal down to its LLTV at today's price.

**Impact.** One borrower chose to run below the buffer. Lenders are protected as long as liquidations work. The risk
is the next closure: when the weekend or event buffer comes into force, the position can become liquidatable while
the market is shut and DEX depth is thin. Watch for a following `MISSED_LIQUIDATION` / `LIQUIDATION_UNPROFITABLE`.

## First 5 minutes

1. From the page: `borrower`, `path` (router/direct), `caller`, `hfNow`, `hfAt24h`, `withdrawn`, `tx`.
2. How close to liquidation: `hfNow` < 1.02 or `hfAt24h` < 1.0 means it becomes liquidatable at the next closure.
   Check the closure calendar (`GET /v1/markets/<ticker>` → `nextClosure`).
3. Size vs market: debt in USD vs the per-address cap and the free liquidity in the market.
4. Several at once, or a large one ahead of a closure: check the liquidator is healthy (`KEEPER_DOWN`) and funded,
   and the DEX route for the seized collateral (MON-R19).

## Decision tree

- Small position, `hfAt24h` ≥ 1.0 → no action: the borrower accepted a thinner buffer. Note it. The incident resolves
  if they top up.
- `hfAt24h` < 1.0 before a closure → make sure the liquidator is running and funded before the market closes. If the
  borrower is known (market maker), contact them to top up (`router.addCollateral`, anyone may top up, RT-R8).
- Large, near the market's free liquidity, and the DEX route unprofitable → [missed-liquidation.md](missed-liquidation.md)
  (backstop liquidation). The guardian may `trip(MANUAL)` to stop new borrowing into the risk.
- A pattern (many borrowers draining collateral before closures) → owner decision on the router change in
  [proposals/T10](../proposals/T10-withdraw-collateral-buffer.md) (HF(t + 24h) ≥ 1.0 on `withdrawCollateral` with
  debt, through the timelock). Direct Morpho withdrawals stay possible, so detection remains.

## Commands

```sh
cast call $MORPHO "position(bytes32,address)(uint256,uint128,uint128)" $MARKET_ID <borrower>
cast call $ROUTER "healthFactorAt(address,address,uint256)(uint256)" $STOCK <borrower> $(( $(date +%s) + 86400 ))
curl -s $LIQUIDATOR_URL/health | jq                                       # liquidator alive before the closure
```

Rehearsed on anvil: detection on both paths and the resolve on top-up (`monitor.test.ts`, MON_R26). Live on 46630: the
tester's direct withdrawal to HF(t + 24h) < 1.10 paged, then resolved on top-up ([testnet-issues.md](testnet-issues.md) T10).

**Who signs.** On-call engineer (triage); guardian 2-of-4 (trip); owner via timelock (router change).

## Comms

None. It is the borrower's own risk, disclosed in the terms. The app shows the HF at t + 24h and offers "Withdraw
collateral" only at zero debt.

## Post-mortem

- [ ] Count per month, and whether any became a liquidation during a closure → input to the T10 router decision.
