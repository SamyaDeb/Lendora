# 01 · Users and user stories

Lenders and borrowers are the launch-critical pair. Without both there is no market.

## Personas

| Persona | Who | Primary job | Phase |
|---|---|---|---|
| Lender | Retail or treasury holding NVDA, AAPL or SPY tokens | Earn yield on idle stock without selling | 1 |
| Borrower | Active trader, perp market maker (Lighter, Arcus), arbitrageur | Short, hedge perp inventory, arb weekend premiums | 1 |
| Liquidator | Existing Morpho liquidator bots | Profit from liquidating unhealthy positions | 1 |
| Data consumer | Traders, perp venues, AI agents, researchers | Read live short interest and borrow rates | 2 |
| Vault depositor | USDG holder who doesn't want stock risk | Price-neutral USDG yield | 4 |
| Backstop staker | Risk-tolerant capital provider | Fee share for first-loss cover | 5 |
| Operator (internal) | Lendora risk team / multisig | Set caps, list markets, respond to incidents | 1 |

## User stories

Each story has an ID that feature PRDs reference.

### Lender

- **US-L1**: As a lender, I deposit 10 NVDA and receive `rNVDA` so I can track my position and earn interest.
- **US-L2**: As a lender, I see supply APY, utilization and how much I can withdraw right now before I deposit.
- **US-L3**: As a lender, I withdraw NVDA plus accrued interest at any time, up to available liquidity.
- **US-L4**: As a lender, I post `rNVDA` as collateral to borrow USDG without giving up lending yield.
- **US-L5**: As a lender, I see my earnings history in NVDA and in USD.

### Borrower

- **US-B1**: As a borrower, I deposit USDG (or USDG vault shares) and borrow NVDA in one transaction.
- **US-B2**: As a borrower, I "open short" in one click: deposit collateral, borrow and sell to USDG via the router.
- **US-B3**: Before confirming, I see my health factor, liquidation price, borrow APR and the current or upcoming weekend buffer.
- **US-B4**: As a borrower, I "close short" in one click: buy back the stock, repay, withdraw collateral.
- **US-B5**: As a borrower, I add collateral or partially repay to improve health.
- **US-B6**: As a borrower, I get alerts (email, Telegram, webhook) when my health factor drops below a threshold I set,
  and a warning 24 hours before weekend mode ramps in.

### Liquidator

- **US-Q1**: As a liquidator, I liquidate Lendora markets with standard Morpho tooling. I can unwrap seized collateral to
  USDG and the wrapped stock to the underlying token permissionlessly.

### Data consumer

- **US-D1**: As a data consumer, I query per-stock short interest, utilization and rate, current and historical, over REST.
- **US-D2**: As a data consumer, I subscribe to live updates over WebSocket.
- **US-D3**: As a smart contract, I read current short interest for a stock onchain in one view call.

### Vault depositor (Phase 4)

- **US-V1**: As a depositor, I deposit USDG, receive shares and see net APY split into lending fees and funding.
- **US-V2**: As a depositor, I withdraw USDG instantly up to the buffer, or join a queue with a shown ETA.

### Operator

- **US-O1**: As an operator, I change supply caps, idle reserve and listed markets through a timelocked multisig.
- **US-O2**: As an operator (guardian), I can shrink caps and pull free liquidity without a timelock, but I cannot move user funds.
- **US-O3**: As an operator, I get paged when a guard trips, an oracle goes stale or a liquidation is missed.
