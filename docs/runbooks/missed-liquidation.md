# Runbook · Missed liquidation (`MISSED_LIQUIDATION`, MON-R2, P0; `LIQUIDATION_UNPROFITABLE`, MON-R19, P1)

**Trigger.** A position has HF < 1.0 (SDK `healthFactorAt` at the current buffer, i.e. what Morpho sees through
`price()`) for more than 2 blocks. Subject `<ticker>:<borrower>`. Resolves when the position is healthy or has no debt.
`LIQUIDATION_UNPROFITABLE` (MON-R19) fires earlier, on the first tick at HF < 1, when the seized collateral (debt ×
LIF at the oracle price) buys less stock than the debt on the best DEX route now: no rational liquidator will act,
so expect `MISSED_LIQUIDATION` next. Same response; the fallback liquidator also skips it unless `minProfit` is 0.

**Impact.** Every block the position stays unliquidated it can slide further under water; if the collateral falls
below the debt the next liquidation realizes bad debt ([bad-debt.md](bad-debt.md)). Usually means third-party
liquidators are not active for this market, cannot unwrap `clUSDG`, or the trade is unprofitable (thin DEX).

## First 5 minutes

1. Confirm: `cast call $ROUTER "healthFactorAt(address,address,uint256)(uint256)" $STOCK <borrower> $(date +%s)`.
2. Check the fallback liquidator bot: `curl $LIQUIDATOR_HEALTH` (keeper `/health`), its logs for "unprofitable" or
   reverts, and its USDG balance (it buys the stock to repay).
3. Check DEX depth for the stock (the bot swaps USDG → stock through the UniversalRouter, A15).
4. If the bot is down, restart it ([keeper-down.md](keeper-down.md)); it liquidates on its next tick.
5. If the bot is up but refuses (unprofitable or slippage), run a manual liquidation (below).

## Decision tree

- Bot down → restart; confirm the incident resolves.
- Bot up, profit < `minProfit` → lower `minProfit` for this run and liquidate at a small loss (protects lenders).
- DEX too thin to buy the repay amount → liquidate in parts (`fraction`), and **guardian trip** to stop new borrows
  while it lasts.
- Position already below 1/LIF (collateral < debt × LIF): a full liquidation realizes bad debt; do it anyway, then
  follow [bad-debt.md](bad-debt.md).

## Commands

```sh
# Manual liquidation through the fallback liquidator (StocklineLiquidator; Morpho callback unwraps clUSDG)
DRY_RUN=false KEEPER_SIGNER=env-key pnpm --filter @stockline/keepers liquidator   # one bot tick liquidates all HF < 1
# Or directly as any address holding the stock: wrap, then Morpho liquidate by shares, then unwrap the seized clUSDG
cast send $WRAPPER "wrap(uint256,address)" <raw> <you>
cast send $MORPHO "liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes)" "$MP" <borrower> 0 <shares> 0x
cast send $CLUSDG "unwrap(uint256,address)" <seized> <you>
```

**Who signs.** Anyone can liquidate (the ops liquidator key); guardian 2-of-4 for a trip.

## Comms

Usually none (liquidations are normal). If bad debt follows, use [bad-debt.md](bad-debt.md).

## Post-mortem

- [ ] Why no third-party liquidator acted (outreach status, `clUSDG` unwrap support, profitability at that size)
- [ ] Bot latency and failure mode; add alerting on the bot's own "unprofitable" log line if it recurs
