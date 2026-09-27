# Runbook · Direct Morpho borrow (`DIRECT_BORROW`, MON-R10, P1)

**Trigger.** A Morpho `Borrow` on a Stockline market whose `caller` is not the router. Subject `<ticker>:<onBehalf>`;
auto-resolves after 1h (A30). This is the accepted soft-gate residual (05 §1): Morpho is permissionless, so a borrower
who was attested once (rescue top-up, RT-R8), a debt-free `clUSDG` holder in Morpho, or a liquidator holding seized
`clUSDG` can borrow directly, without a fresh attestation and beyond the per-address cap.

**Impact.** Bounded by the liquidity the allocator placed in the market (vault caps, idle reserve, pulls). The
compliance risk is a geo-blocked or sanctioned address borrowing; the market risk is one address exceeding the
per-address cap sized for liquidation depth (D8).

## First 5 minutes

1. Who: `onBehalf` and `caller` from the page; position size: `cast call $MORPHO "position(bytes32,address)(uint256,uint128,uint128)" $MARKET_ID <onBehalf>`.
2. Was this address attested? Compliance DB (terms acceptance), and whether it is on the sanctions provider now.
3. Debt in USD vs the market's per-address cap (`cast call $ROUTER "capOf(address,address)(uint256)" <addr> $STOCK`).
4. Several direct borrowers at once, or a size near the market's free liquidity → guardian `trip(MANUAL)` + pull.
5. Log it in the compliance register.

## Decision tree

- Known market maker with an override, or a small top-up within the cap → no action; note it.
- Size above the per-address cap → risk review: tighten the vault cap (sentinel, instant) if liquidation depth cannot
  absorb it; contact the borrower if known.
- Sanctioned / restricted address → Compliance escalation; guardian trip to stop further liquidity; the position cannot
  be seized (no admin power), but its liquidity access can be cut by caps; counsel decides on reporting.
- Many direct borrows (a pattern) → owner lowers the global `clUSDG` cap through the timelock so no new collateral
  enters via the router (rescue top-ups for existing debt keep working, RT-R8).

## Commands

```sh
cast calldata "trip(uint256)" 1                                             # guardian Safe, to = $ORACLE
cast calldata "decreaseAbsoluteCap(bytes,uint256)" $ADAPTER_ID <newCap>     # sentinel, to = $VAULT
pnpm --filter @stockline/sdk timelock router.setGlobalCap cap=<raw clUSDG> --network $NET --salt "$(date -u +%F) global cap"
pnpm --filter @stockline/sdk timelock router.setCapOverride user=<addr> ticker=NVDA capUsdWad=0 --network $NET --salt "<date> cap override reset"
```

Rehearsed on anvil: detection (`monitor.test.ts`), global cap through the timelock stops router entries
(`runbooks.test.ts`).

**Who signs.** Guardian 2-of-4 (trip, cap decrease); owner via timelock (global cap, overrides). Compliance owns the
address review.

## Comms

None publicly unless a sanctioned address is involved (counsel decides).

## Post-mortem

- [ ] Count and size of direct borrows per month; whether the residual needs a design change (e.g. a gated Morpho
      fork is **not** an option: Morpho stays unmodified)
