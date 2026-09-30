# web

Lendora app (package and SDK still named Lendora, open question Q6) (docs/prd/06): Next.js 16 App Router, wagmi 3 + viem, TanStack Query, Tailwind 4. Every safety number
(health factor, liquidation price, buffer, rates) comes from `@lendora/sdk`; lists and charts from the public API,
positions and previews straight from the chain.

| Route | |
|---|---|
| `/` | Marketing landing page (own root layout, `app/(marketing)`), ported from the Lendora landing prototype (`client/`) |
| `/markets` | Borrow board: summary strip, search and filters, sortable table (utilization bar vs `U_MAX`, lend APY, borrow APR with a 7-day sparkline, Easy / Tight / Hard to borrow), cards on mobile |
| `/stock/[ticker]` | Stats, rate / utilization and short-interest charts (7d/30d/90d, closures shaded), risk settings in plain words, weekend buffer schedule, contracts; sticky Lend / Borrow / Short panel (bottom sheet on mobile) |
| `/portfolio` | Positions from the chain, riskiest first: health meter, liquidation price now and during the next closure, Add collateral / Repay / Close; lending receipts with fees earned and ready-now vs lent-out; history |
| `/data` | 07 §4 dashboard: most shorted, biggest changes today and this week, leaderboard, per-stock chart, weekend panel, API snippets |
| `/vault`, `/backstop` | 08 / 09 §2 previews behind `NEXT_PUBLIC_FEATURE_VAULT=1` / `NEXT_PUBLIC_FEATURE_BACKSTOP=1` (no contracts yet; actions disabled) |
| `/alerts` | APP-R8 settings, saved with a signed message |
| `/status`, `/terms`, `/restricted` | APP-R4 status link target, APP-R10 terms, APP-R2 block page |
| `/market/*`, `/lend/*`, `/short/*`, `/short-interest` | Redirects to the routes above |
| `/dev/components`, `/dev/preview/[page]` | Dev only (off in production unless `NEXT_PUBLIC_DEV_PAGES=1`): every UI primitive in every state; page views on fixtures (`?state=open\|weekend\|paused\|loading\|error`) |

Every action (lend, withdraw, borrow, short, add collateral, repay, close) opens the review sheet (`components/review`):
amounts in token and USD, health meter, liquidation price now and during the next closure, collateral required incl.
the weekend buffer, rate, and the step list; borrow and short can't be confirmed without a liquidation price.

Design system: `app/tokens.css` is the only source of colors, type, radius, elevation and motion, taken from the
Lendora landing page (`client/`). Primitives in `components/ui`; data and transaction logic in `lib/flows` (the calls
and step lists the old panels used, unchanged), views take props so they render on `lib/fixtures`.

| Req | Where |
|---|---|
| APP-R1 | `lib/wagmi.ts` (injected, WalletConnect with a project id, Coinbase Wallet); `ConnectButton` wrong-network prompt |
| APP-R2 | `proxy.ts` (Next 16 Proxy, the successor of edge middleware): restricted countries/regions from the SDK config see `/restricted`; `/portfolio`, `/terms`, `/status`, `/api/*` stay reachable for exits |
| APP-R3 | `lib/tx.ts` step list, `eth_call` simulation before every send, `lib/errors.ts` plain-language reasons |
| APP-R4 | `GuardBanner`, borrow disabled with the reason and a status link; exits enabled |
| APP-R5 | API for lists/charts (`lib/api.ts`), chain for positions and the preview (`lib/chain.ts`, one batched JSON-RPC request) |
| APP-R6 | `HealthFactor` colors; copy says liquidation at 1.00 |
| APP-R7 | 5 s refresh (and after every tx) |
| APP-R9 | Keyboard navigable, skip link, AA contrast tokens (light and dark), 360 px layouts; Lighthouse accessibility 100 |
| APP-R10 | Footer notice; terms signed once per wallet through the compliance service (`/api/compliance/*` proxy adds geo headers + `PROXY_SECRET`) |
| APP-R11 | `lib/analytics.ts` + `/api/analytics`: event, funnel and path only; no wallet, no cookies, no IP stored |

## Run and test

```sh
scripts/dev.sh                                   # whole stack; web on :3000
pnpm --filter @lendora/web test                # component and unit tests
pnpm --filter @lendora/web e2e                 # Playwright on anvil: every router flow, preview vs onchain ≤ 0.1%
pnpm --filter @lendora/web lighthouse          # writes lighthouse/results.md
```

E2E uses wagmi's mock connector bound to anvil's unlocked default account #7 (`NEXT_PUBLIC_E2E=1`, anvil only): no key
material anywhere. Results: `lighthouse/results.md` (performance 96 on `/`, 94 on `/short-interest`).
