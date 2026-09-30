# 02 · System architecture

Lendora is a thin layer around Morpho Blue. It adds a small set of contracts, a few offchain services and a web
app. Morpho Blue and Morpho Vault V2 are used unmodified (D6: no MetaMorpho v1 factory exists on Robinhood Chain).

## Component map

```
                        ┌──────────────────────── Web app (Next.js) ───────────────────────┐
                        │  Lend · Borrow/Short · Positions · Short-interest dashboard       │
                        └──────────────┬───────────────────────────────┬───────────────────┘
                                       │ tx (viem/wagmi)               │ REST / WS
                                       ▼                               ▼
┌────────────────── Lendora contracts ────────────────────┐   ┌──── Offchain ─────────────────┐
│ LendoraRouter (bundles: open/close short, lend, ...)     │   │ Indexer (Ponder) → Postgres   │
│ StockWrapper  wNVDA  (non-rebasing wrapper of NVDA)       │   │ Public API (REST + WS)        │
│ CollateralToken clUSDG (gated USDG wrapper)               │   │ Keepers: allocator, guard,    │
│ LendoraOracle (per market; closure/event buffer, guards)  │   │   liquidator, fee conv, alerts│
│ MarketHours (feed sessions + event windows)               │   │ Monitoring + paging           │
│ LendoraLiquidator · ShortInterestLens · FeeSplitter       │   └───────────────────────────────┘
│ TimelockController (owner of the above and the vaults)    │
└─────────────┬───────────────────────────────┬────────────┘
              ▼                               ▼
   Vault V2 rNVDA ──MarketV1AdapterV2──►  Morpho Blue market
   (caps, idle reserve = unallocated,     loan = wNVDA, collateral = clUSDG,
    perf fee → FeeSplitter)               oracle = LendoraOracle, IRM = AdaptiveCurve, LLTV 77%
                                                    ▲
                                   Chainlink feeds ─┘ (NVDA/USD, USDG/USD)
```

## Contracts

| Contract | Purpose | Upgradeable | Spec |
|---|---|---|---|
| Morpho Blue | Lending engine (existing deployment) | No | Deployed at `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010` (verified Phase 0, 2026-09-26) |
| Morpho Vault V2 `rNVDA` etc. | Lender vault per stock from the official `VaultV2Factory`, ERC-4626; share = receipt token; one `MorphoMarketV1AdapterV2` from the official factory | No (curator actions timelocked 48h) | [03](03-lending-markets.md) |
| `StockWrapper` | Wraps a Stock Token into a fixed-balance ERC-20 Morpho can hold; `backingShortfall()` view | No | [03](03-lending-markets.md) |
| `BlocklistHolderAllowlist` | Optional pre-check adapter for `unwrap`: `!registry.isBlocked(to)` | No | [03](03-lending-markets.md) |
| `CollateralToken` (`clUSDG`) | Gated borrower collateral; wraps USDG or a USDG vault share | No | [05](05-collateral-router.md) |
| `LendoraOracle` | Morpho `IOracle` per market; Chainlink feed (multiplier already included, D1) + closure/event buffer + guards | No; params via timelock | [04](04-oracle.md) |
| `ReceiptCollateralOracle` | Morpho `IOracle` for `rSTOCK`-collateral / USDG-loan markets (G5) | No; params via timelock | [04](04-oracle.md) |
| `MarketHours` | Chainlink 24/5 feed sessions (holidays, early closes) and per-stock event windows (earnings) | Owner-set schedule (timelock) | [04](04-oracle.md) |
| `LendoraRouter` | One-transaction flows (lend, open/close short, repay, add collateral) | Yes (UUPS, timelocked); holds no funds between txs | [05](05-collateral-router.md) |
| `ShortInterestLens` | View contract aggregating market state per stock | No (redeployable) | [07](07-short-interest.md) |
| `LendoraLiquidator` | Fallback liquidator: Morpho liquidation callback → unwrap `clUSDG` → swap → wrap → repay; holds nothing after a call | No (redeployable) | [03](03-lending-markets.md) |
| `TimelockController` | OpenZeppelin timelock; owner of oracles, `MarketHours`, router, vaults | No | this doc |
| `FeeSplitter` | Splits vault performance fees: backstop / treasury | No | [09](09-backstop-fees.md) |
| `DeltaNeutralVault` | Phase 4 USDG vault | TBD | [08](08-delta-neutral-vault.md) |
| `BackstopPool` | Phase 5 first-loss staking | TBD | [09](09-backstop-fees.md) |

Per stock, Lendora deploys: one `StockWrapper`, one `LendoraOracle` for the stock-loan market, one Vault V2 with one
market adapter, and one Morpho market. For G5 (`rNVDA` as collateral) it adds a second market and oracle (loan = USDG, collateral = `rNVDA`).

## Offchain services

| Service | Responsibility | Spec |
|---|---|---|
| Indexer | Index Morpho, Vault V2, Lendora events into Postgres; compute short interest | [07](07-short-interest.md) |
| Public API | REST + WebSocket, API keys, rate limits | [07](07-short-interest.md) |
| Allocator keeper | `allocate`/`deallocate`s each rNVDA vault between idle and the market; enforces the utilization cap; pulls liquidity on guard trip and before earnings | [03](03-lending-markets.md) |
| Guard keeper | Compares oracle price with a DEX TWAP, calls `oracle.poke()`, trips/clears offchain reasons, watches issuer flags and L2 block gaps | [04](04-oracle.md) |
| Fallback liquidator | Watches positions, liquidates through `LendoraLiquidator` | [03](03-lending-markets.md) |
| Fee converter | Swaps protocol fee shares to USDG and forwards them | [09](09-backstop-fees.md) |
| Alerts | Health-factor and weekend warnings to email, Telegram, webhooks | [06](06-web-app.md) |
| Monitoring | Dashboards, paging (bad debt, stale oracle, missed liquidations) | [10](10-risk-compliance.md) |

Liquidations use the existing Morpho liquidator network. Lendora also runs a fallback liquidator bot, so the protocol
never depends on third parties at launch caps.

## Roles and permissions

| Role | Holder | Can | Timelock |
|---|---|---|---|
| Owner | 4-of-7 multisig acting through a `TimelockController` (the timelock is the onchain owner of oracles, `MarketHours`, router and each vault) | List markets, set oracle params, push calendars, upgrade router, set vault curator/sentinels | 48h (24h on testnet) |
| Curator (Vault V2) | Same multisig | Add adapters, raise caps, set allocators, fees | Vault V2 timelock, 48h on harmful actions; decreases instant |
| Allocator (Vault V2) | Keeper EOA + multisig | `allocate` / `deallocate` between idle and the market; `setMaxRate` | None |
| Guardian (= Vault V2 Sentinel) | 2-of-4 multisig | `deallocate`, lower caps, revoke pending actions, trip the oracle guard, raise the buffer floor | None (can only reduce risk) |
| Fee recipient | `FeeSplitter` | Receive performance fees | n/a |

No role can move user funds or change a live Morpho market's LLTV, IRM or oracle address, because Morpho markets are immutable.

## Tech stack

| Layer | Choice |
|---|---|
| Contracts | Solidity 0.8.x, Foundry (forge, cast, anvil), OpenZeppelin, Morpho Blue (`v1.0.0`) and Morpho Vault V2 (`2025-12-04`, matches the onchain factory) as git submodules |
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
