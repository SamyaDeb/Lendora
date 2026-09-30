# Runbook · Bad debt (`BAD_DEBT`, MON-R1, P0)

**Trigger.** Morpho `Liquidate` on a Lendora market with `badDebtAssets > 0`. The page carries the market, borrower,
tx hash, `badDebtAssets` (raw wSTOCK) and `seizedAssets` (clUSDG). Auto-resolves after 24h (A30); the follow-up is this
runbook.

**Impact.** Morpho has already socialized the loss: the market's `totalSupplyAssets` dropped by `badDebtAssets`, so the
vault's allocation, and every `rSTOCK` holder's share price, dropped pro rata. Nothing is stuck; lenders simply own
less wSTOCK. Repeated bad debt means the buffer, caps or LLTV are wrong for current volatility.

## First 5 minutes

1. Confirm on chain: `cast receipt <tx> --rpc-url $RPC` and the `Liquidate` log (`badDebtAssets`, `badDebtShares`).
2. Size it in USD: `badDebtAssets × stockAnswer / 1e8` (`cast call $ORACLE "stockAnswer()(uint256,uint256)"`).
3. Check whether more positions are at risk: `curl $MONITOR_URL/incidents | jq '.open[] | select(.rule=="MISSED_LIQUIDATION")'`
   and the market's HF distribution in the app's dashboard / API `GET /v1/markets/<ticker>`.
4. If any other position is below HF 1 or the move is still running: **guardian trip** (below) to pull liquidity.
5. Post the first comms update.

## Decision tree

- Loss < 0.5% of the market's supply and a one-off (e.g. one Monday gap beyond the buffer) → no onchain action;
  post-mortem with a sim rerun of σ/z for that stock.
- More positions near HF 1, or the move continues → guardian `trip(MANUAL)`; confirm the allocator pulled
  ([guard-tripped.md](guard-tripped.md)); keep it tripped until the feed and DEX agree again.
- Loss ≥ 0.5% of supply, or a second bad-debt event in 30 days → owner proposes stricter parameters through the
  timelock (raise σ or `B_MIN`, lower the vault cap) and, if the sim says so, stops the market
  (`router.delistMarket`, the vault cap to 0 by the sentinel). Exits keep working.

## Commands

```sh
# Guardian (Safe, 2 of 4): pause new borrowing in the market
cast calldata "trip(uint256)" 1                      # to = $ORACLE
# Sentinel (guardian Safe): stop new supply being lent out (instant cap decrease), and pull free liquidity
cast calldata "decreaseAbsoluteCap(bytes,uint256)" $ADAPTER_ID 0   # to = $VAULT
# Owner (timelock): stop router entries in the market
pnpm --filter @lendora/sdk timelock router.delistMarket ticker=NVDA --network $NET --salt "$(date -u +%F) NVDA delist"
```

**Who signs.** Guardian 2-of-4 for the trip and cap decrease (instant). Owner 4-of-7 through the timelock for delisting
and parameter changes (48h).

## Comms

> **Identified — NVDA lending market: bad debt of <X> NVDA (~$<Y>)** (<UTC>). A liquidation on <date> could not cover a
> position after <cause, e.g. the Monday open gapped +N%>. The loss is shared by NVDA lenders (rNVDA share price −<Z>%).
> Borrowers are not affected. New borrowing in NVDA is <paused | unaffected>. Post-mortem by <date>.

## Post-mortem (in addition to the [base checklist](README.md#post-mortem-base-checklist-within-5-business-days-of-a-p0-or-a-user-facing-p1))

- [ ] Price path vs buffer: was the gap inside `b_full` for the closure? Was the buffer fully ramped?
- [ ] Liquidation latency: blocks from HF < 1 to the first liquidation; was `MISSED_LIQUIDATION` paged?
- [ ] DEX depth at the time vs the per-address and vault caps (10 launch parameters)
