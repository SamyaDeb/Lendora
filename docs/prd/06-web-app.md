# 06 · Web app

**Phase 2.** A responsive Next.js app with four areas: Markets, Lend, Borrow/Short and Portfolio (Lend and Borrow/Short share one page per stock). It also hosts the public
short-interest dashboard ([07](07-short-interest.md)). Every number that affects safety (health factor, liquidation price,
buffer) comes from `packages/sdk` so it matches the contracts.

## Screens

*(Routes updated 2026-09-29 to match the app after the Lendora redesign. The original plan's `/`, `/market/[symbol]`,
`/lend/[symbol]`, `/short/[symbol]` and `/short-interest` still resolve: each redirects to its new home below.)*

| Route | Purpose | Key elements |
|---|---|---|
| `/` | Landing (marketing) | What Lendora is (lend, borrow, short, short-interest data, USDG Earn), live rates per Stock Token and live totals from the public API (no numbers when the API is down), safety and availability, links into the app. Footer has the "not an offer of securities" notice. |
| `/markets` | Markets overview (was `/`) | Table per stock: price, supplied, borrowed, utilization, supply APY, borrow APR, market status (Open / Closed · weekend mode / Guard tripped), borrow availability. Sort by utilization; search and filter. |
| `/stock/[ticker]` | Market detail + Lend / Borrow / Short (was `/market`, `/lend`, `/short`) | Rate and utilization charts (7d/30d/90d), short-interest history, weekend buffer schedule, contract addresses, parameters (LLTV, caps, `U_MAX`). Action panel (sticky on desktop, bottom sheet on mobile): **Lend** (amount, APY, withdrawable now, `rSTOCK` balance, earnings in stock and USD, "use as collateral" shown as coming later, G5) and **Borrow / Short** (USDG collateral, borrow amount or target health factor, the preview panel below; vault-share collateral shown as coming later). `?tab=lend\|borrow\|short` picks the tab. |
| `/portfolio` | Positions | Lends, borrows, health factors, liquidation prices now and at next close, accrued interest, one-click Close / Repay / Add collateral; USDG Earn position with withdraw and claim when the vault flag is on. Reachable from restricted regions (exits). |
| `/data` | Public short-interest dashboard (was `/short-interest`) | See [07](07-short-interest.md); plus protocol revenue (FE-R5). |
| `/alerts` | Notification settings | HF threshold, channels (email, Telegram, webhook URL), weekend warning toggle |
| `/status` | Guard and oracle status | APP-R4 link target: guard state and reasons per market, oracle freshness, indexer lag. |
| `/terms` | Terms and risk disclosure | APP-R10: the text the wallet signs, with its version and hash. |
| `/restricted` | Block page | APP-R2: shown instead of entry routes in restricted regions. |
| `/vault` | USDG Earn ([08](08-delta-neutral-vault.md), Phase 4) | Behind `NEXT_PUBLIC_FEATURE_VAULT`; on fixture data until the vault contracts and `/v1/vault/*` exist. |
| `/backstop` | Backstop pool ([09 §2](09-backstop-fees.md), Phase 5) | Behind `NEXT_PUBLIC_FEATURE_BACKSTOP`; preview data, actions disabled. |

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

- [ ] All flows in [05 §4](05-collateral-router.md) completed from the UI on testnet by 20 external testers. **Pending
  testers** (and the testnet go). Engineering done: every flow driven through the UI by Playwright on anvil
  ([`flows.spec.ts`](../../web/e2e/flows.spec.ts)); tester kit in [`runbooks/testnet.md`](../runbooks/testnet.md).
- [x] Preview numbers match the onchain result after execution within 0.1% (automated e2e test with Playwright on anvil):
  preview HF equals `healthFactorAt` exactly, debt within 1 wei ([`flows.spec.ts`](../../web/e2e/flows.spec.ts)
  "06 acceptance"). Run on plain anvil with the DeployLocal state rather than an anvil fork (A16: testnet has no Stock
  Token markets to fork; the same contracts run on the fork suite).
- [x] Lighthouse performance ≥ 85 on the markets overview and the short-interest dashboard (then `/` and `/short-interest`, now `/markets` and `/data`): 96 and 91 (accessibility 100)
  ([`lighthouse/results.md`](../../web/lighthouse/results.md)).
