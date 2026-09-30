# Runbook · Wrapper backing shortfall (`BACKING_SHORTFALL`, MON-R3, P0)

**Trigger.** `StockWrapper.backingShortfall() > 0` (LM-R8): the wrapper holds fewer Stock Tokens than `wSTOCK` supply.
The only known cause is the issuer's `adminBurn` on the wrapper address (D10, verified Phase 0); a token bug is the
other.

**Impact.** Every `wSTOCK` is now backed by less than one Stock Token. Unwraps are first-come, first-served: the last
holders to unwrap (lenders withdrawing `rSTOCK`, borrowers' repayments are unaffected) cannot exit fully
([`Lifecycle.fork.t.sol` adminBurn test](../../contracts/test/fork/phase1/Lifecycle.fork.t.sol)). Nothing onchain can
prevent or reverse it.

## First 5 minutes

1. Confirm: `cast call $WRAPPER "backingShortfall()(uint256)"`, and find the burn:
   `cast logs --address $STOCK "Transfer(address,address,uint256)" --from-block <recent> | grep -i ${WRAPPER#0x}` (to = 0x0).
2. Guardian **trip(MANUAL)** on the oracle and let the allocator pull; sentinel **cap to 0** so no new lending.
3. Contact the issuer (06 B2: issuer policy on `adminBurn`) through the agreed channel; ask whether it is a reversible
   error.
4. Owner proposes `router.delistMarket` (48h) — entries stop now anyway because of the guard.
5. Publish comms. Do **not** advise users to rush to unwrap.

## Decision tree

- Issuer reverses it (re-mints to the wrapper) → shortfall 0, monitor resolves; clear the guard after 1h of no change.
- Issuer confirms a legal/regulatory burn → the market is wound down: keep delisted, cap 0, guard tripped; exits stay
  open; distribution of the loss is decided in the post-mortem with counsel (terms, CP-R6).
- Shortfall without an issuer burn → token bug; same wind-down, escalate to the issuer and the auditors.

## Commands

```sh
cast calldata "trip(uint256)" 1                                                      # guardian, to = $ORACLE
cast calldata "decreaseAbsoluteCap(bytes,uint256)" $ADAPTER_ID 0   # sentinel, to = $VAULT
pnpm --filter @lendora/sdk timelock router.delistMarket ticker=NVDA --network $NET --salt "$(date -u +%F) NVDA shortfall delist"
```

**Who signs.** Guardian 2-of-4 (trip, cap), owner 4-of-7 via timelock (delist). BD/Legal own the issuer contact.

## Comms

> **Investigating — NVDA: the Stock Token issuer burned <X> NVDA held by the Lendora wrapper** (<UTC>). wNVDA is now
> backed <Y>%. New lending and borrowing in NVDA are paused. Repay and close keep working. We are in contact with the
> issuer. Next update by <time>.

## Post-mortem

- [ ] Issuer's reason; whether it can recur; policy agreement (06 B2)
- [ ] Loss per holder class; terms/disclosure adequacy with counsel
