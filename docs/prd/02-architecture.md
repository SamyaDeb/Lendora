# 02 · System architecture

Stockline is a thin layer around Morpho Blue. It adds a small set of contracts, a few offchain services and a web
app. Morpho Blue and MetaMorpho are used unmodified.

## Component map

```
                        ┌──────────────────────── Web app (Next.js) ───────────────────────┐
                        │  Lend · Borrow/Short · Positions · Short-interest dashboard       │
                        └──────────────┬───────────────────────────────┬───────────────────┘
                                       │ tx (viem/wagmi)               │ REST / WS
                                       ▼                               ▼
┌────────────────── Stockline contracts ──────────────────┐   ┌──── Offchain ─────────────────┐
│ StocklineRouter (bundles: open/close short, lend, ...)   │   │ Indexer (Ponder) → Postgres   │
│ StockWrapper  wNVDA  (non-rebasing wrapper of NVDA)       │   │ Public API (REST + WS)        │
│ CollateralToken clUSDG (gated USDG / USDG-vault wrapper)  │   │ Keepers: allocator, guards,   │
│ StocklineOracle (per market; weekend mode, guards)        │   │   fee converter, alerts       │
│ MarketHours (US exchange calendar)                        │   │ Monitoring + paging           │
│ ShortInterestLens (view)                                  │   └───────────────────────────────┘
│ FeeSplitter                                               │
└─────────────┬───────────────────────────────┬────────────┘
              ▼                               ▼
   MetaMorpho vault rNVDA  ──supply──►  Morpho Blue market
   (supply cap, idle reserve,           loan = wNVDA, collateral = clUSDG,
    perf fee → FeeSplitter)             oracle = StocklineOracle, IRM = AdaptiveCurve, LLTV 77%
                                                    ▲
                                   Chainlink feeds ─┘ (NVDA/USD, USDG/USD)
```

## Contracts

| Contract | Purpose | Upgradeable | Spec |
|---|---|---|---|
| Morpho Blue | Lending engine (existing deployment) | No | Deployed at `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010` (verified Phase 0, 2026-09-26) |
| MetaMorpho `rNVDA` etc. | Lender vault per stock, ERC-4626; share = receipt token | No (params timelocked) | [03](03-lending-markets.md) |
| `StockWrapper` | Wraps a Stock Token into a fixed-balance ERC-20 Morpho can hold | No | [03](03-lending-markets.md) |
| `CollateralToken` (`clUSDG`) | Gated borrower collateral; wraps USDG or a USDG vault share | No | [05](05-collateral-router.md) |
| `StocklineOracle` | Morpho `IOracle` per market; Chainlink + multiplier + weekend buffer + guards | No; params via timelock | [04](04-oracle.md) |
| `MarketHours` | US equity calendar: open/closed, holidays, early closes | Admin-set schedule | [04](04-oracle.md) |
| `StocklineRouter` | One-transaction flows (lend, open/close short, repay, add collateral) | Yes (UUPS, timelocked); holds no funds between txs | [05](05-collateral-router.md) |
| `ShortInterestLens` | View contract aggregating market state per stock | No (redeployable) | [07](07-short-interest.md) |
| `FeeSplitter` | Splits vault performance fees: backstop / treasury | No | [09](09-backstop-fees.md) |
| `DeltaNeutralVault` | Phase 4 USDG vault | TBD | [08](08-delta-neutral-vault.md) |
| `BackstopPool` | Phase 5 first-loss staking | TBD | [09](09-backstop-fees.md) |

Per stock, Stockline deploys: one `StockWrapper`, one `StocklineOracle` for the stock-loan market, one MetaMorpho vault and
one Morpho market. For G5 (`rNVDA` as collateral) it adds a second market and oracle (loan = USDG, collateral = `rNVDA`).

## Offchain services

| Service | Responsibility | Spec |
|---|---|---|
| Indexer | Index Morpho, MetaMorpho, Stockline events into Postgres; compute short interest | [07](07-short-interest.md) |
| Public API | REST + WebSocket, API keys, rate limits | [07](07-short-interest.md) |
| Allocator keeper | Rebalances each rNVDA vault between the market and the idle market; enforces the utilization cap; pulls liquidity on guard trip | [03](03-lending-markets.md) |
| Guard keeper | Compares oracle price with DEX price, calls `oracle.poke()` to trip or clear guards | [04](04-oracle.md) |
| Fee converter | Swaps protocol fee shares to USDG and forwards them | [09](09-backstop-fees.md) |
| Alerts | Health-factor and weekend warnings to email, Telegram, webhooks | [06](06-web-app.md) |
| Monitoring | Dashboards, paging (bad debt, stale oracle, missed liquidations) | [10](10-risk-compliance.md) |

Liquidations use the existing Morpho liquidator network. Stockline also runs a fallback liquidator bot, so the protocol
never depends on third parties at launch caps.

## Roles and permissions

| Role | Holder | Can | Timelock |
|---|---|---|---|
| Owner | 4-of-7 multisig | List markets, set oracle params, set vault caps, upgrade router | 48h (24h on testnet) |
| Curator (MetaMorpho) | Same multisig | Enable markets and set caps on vaults | MetaMorpho timelock, 48h |
| Allocator | Keeper EOA + multisig | Reallocate between the market and the idle market | None |
| Guardian | 2-of-4 multisig | Lower caps, revoke pending actions, trip the oracle guard | None (can only reduce risk) |
| Fee recipient | `FeeSplitter` | Receive performance fees | n/a |

No role can move user funds or change a live Morpho market's LLTV, IRM or oracle address, because Morpho markets are immutable.

## Tech stack

| Layer | Choice |
|---|---|
| Contracts | Solidity 0.8.x, Foundry (forge, cast, anvil), OpenZeppelin, Morpho Blue and MetaMorpho as git submodules |
| Testing | Forge unit + fuzz + invariant tests; fork tests against Robinhood Chain RPC |
| Indexer | Ponder (TypeScript) → Postgres |
| API | TypeScript (Hono or Fastify), Redis for rate limits and WS fan-out |
| Keepers | TypeScript + viem, run as separate processes with health checks |
| Web | Next.js (App Router), wagmi + viem, TanStack Query, Tailwind |
| Infra | Railway or similar for services; Postgres managed; Grafana + alerting |
| Simulation | Python (pandas, numpy) for parameter tuning and vault backtests |

## Repo layout (monorepo)

```
/contracts        Foundry project (src/, test/, script/, lib/)
/indexer          Ponder project
/api              Public API service
/keepers          allocator, guard, fee-converter, liquidator, alerts
/web              Next.js app
/sim              Python simulations and notebooks
/packages/sdk     Shared TS types, ABIs, addresses, math (health factor, buffer)
/docs             Litepaper, PRD, runbooks
```

`packages/sdk` is the single source for addresses, ABIs and the health-factor and buffer math. The web app, API and keepers
must all import from it so the numbers match everywhere.
