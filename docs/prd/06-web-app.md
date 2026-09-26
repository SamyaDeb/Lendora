# 06 · Web app

**Phase 2.** A responsive Next.js app with four areas: Markets, Lend, Borrow/Short and Portfolio. It also hosts the public
short-interest dashboard ([07](07-short-interest.md)). Every number that affects safety (health factor, liquidation price,
buffer) comes from `packages/sdk` so it matches the contracts.

## Screens

| Route | Purpose | Key elements |
|---|---|---|
| `/` | Markets overview | Table per stock: price, supplied, borrowed, utilization, supply APY, borrow APR, market status (Open / Closed · weekend mode / Guard tripped). Sort by utilization. |
| `/market/[symbol]` | Market detail | Rate and utilization charts (7d/30d/90d), short-interest history, weekend buffer schedule, contract addresses, parameters (LLTV, caps, `U_MAX`) |
| `/lend/[symbol]` | Deposit / withdraw | Amount input, APY, `maxWithdraw`, `rSTOCK` balance, earnings in stock and USD, "use as collateral" CTA (G5) |
| `/short/[symbol]` | Open short / borrow | Collateral input (USDG or vault share), borrow amount or target LTV slider, toggle "sell borrowed stock" (openShort) vs "just borrow", live preview panel |
| `/portfolio` | Positions | Lends, borrows, health factors, liquidation prices now and at next close, accrued interest, one-click Close / Repay / Add collateral |
| `/short-interest` | Public dashboard | See [07](07-short-interest.md) |
| `/alerts` | Notification settings | HF threshold, channels (email, Telegram, webhook URL), weekend warning toggle |

## Preview panel (Borrow/Short)

It must show, before signing:

- Borrow amount in shares and USD, borrow APR (current) and the rate at +10% utilization.
- Health factor now, at next close with full buffer, and at a hypothetical +10% price move.
- Liquidation price now and during the next closure.
- Countdown to the next ramp-in, for example "Weekend mode starts ramping Fri 12:00 ET (in 2d 4h). Buffer at close: 10.1%".
- Swap quote with price impact and min received (openShort).
- For stocks: a note that borrowers owe manufactured dividends via the multiplier ([03 §1](03-lending-markets.md)).

## Requirements

| ID | Requirement |
|---|---|
| APP-R1 | Wallet connect via wagmi (injected, WalletConnect, Coinbase Wallet). Chain = Robinhood Chain. Wrong-network prompts to switch. |
| APP-R2 | Geo-block: restricted-country visitors see a block page (edge middleware on IP country). Borrow and openShort also need the attestation (RT-R2). Repay, close and withdraw are never geo-blocked, so users can always exit. |
| APP-R3 | All transactions show a step list (approve / authorize / execute), simulate first (`eth_call`) and surface decoded revert reasons in plain language. |
| APP-R4 | When the guard is tripped for a market, Borrow/Short is disabled with the reason and a link to the status page. Exits stay enabled. |
| APP-R5 | Data reads come from the API ([07](07-short-interest.md)) for lists and charts, and directly from the chain (multicall) for the connected user's positions and the preview. |
| APP-R6 | Health factor colors: ≥ 1.5 green, 1.1–1.5 amber, < 1.1 red. Liquidation happens at 1.0, and copy says so. |
| APP-R7 | Portfolio positions refresh on each new block (or every 5s) and after every user tx. |
| APP-R8 | Alerts: the backend watches positions from the indexer and sends a message when HF < user threshold, and 24h and 4h before weekend ramp-in when HF at full buffer < 1.2. Delivery in under 60s from the triggering block. |
| APP-R9 | Accessibility: keyboard navigable, WCAG AA contrast, works at 360px width. |
| APP-R10 | Legal: terms and risk disclosure accepted once per wallet (signed message stored server-side). Footer has the "not an offer of securities" notice. |
| APP-R11 | Analytics: privacy-respecting page and funnel events (connect → preview → sign → confirmed), with no wallet-to-IP linkage stored. |

## States to design

Empty (no positions), loading, pending tx, tx failed, guard tripped, weekend mode ramping, weekend mode active, oracle stale,
market at cap, vault withdrawal limited by liquidity, restricted region, unsupported wallet.

## Acceptance criteria

- [ ] All flows in [05 §4](05-collateral-router.md) completed from the UI on testnet by 20 external testers.
- [ ] Preview numbers match the onchain result after execution within 0.1% (automated e2e test with Playwright on an anvil fork).
- [ ] Lighthouse performance ≥ 85 on `/` and `/short-interest`.
