# 07 · Short-interest data (indexer, API, lens, dashboard)

**Phase 2.** Every Stockline borrow is onchain. Stockline publishes per-stock supply, borrowed amount, utilization and borrow
rate in real time through a public dashboard, a REST/WebSocket API and an onchain view contract. TradFi short interest is
reported twice a month with a delay. This data is live.

## Definitions

All values are per stock and all include only Stockline markets. Every response labels this scope.

| Field | Definition |
|---|---|
| `supplied` | `market.totalSupplyAssets` + idle (unallocated) assets of the `rSTOCK` Vault V2, in shares of stock (after multiplier) |
| `borrowed` (short interest) | `market.totalBorrowAssets`, in shares of stock (after multiplier) |
| `borrowedUsd` | `market.totalBorrowAssets × P_wrapped` (Chainlink feed per wrapped unit, no buffer, D1) |
| `utilization` | `totalBorrowAssets / totalSupplyAssets` of the stock-loan market |
| `utilizationVault` | `borrowed / supplied` (includes idle reserve) |
| `borrowApr` / `supplyApy` | From the IRM's current rate. Supply APY is net of the vault performance fee. |
| `siPctFloat` | `borrowed / token circulating supply` of the Stock Token on Robinhood Chain (`totalSupply()` of the Stock Token contract, raw units, or `totalSupplyUI()` in shares (verified Phase 0, 2026-09-26)) |
| `daysToCover` | `borrowed / 30d average daily DEX volume` of the Stock Token |
| `borrowers` | Count of addresses with `borrowShares > 0` |
| `newShorts24h` / `covered24h` | Sum of borrow and repay amounts in the last 24h |
| `marketStatus` | `open`, `closed`, `ramping`, `guard_tripped` |

## 1. Indexer

| ID | Requirement |
|---|---|
| SI-R1 | Ponder indexes Morpho Blue (`CreateMarket`, `Supply`, `Withdraw`, `Borrow`, `Repay`, `SupplyCollateral`, `WithdrawCollateral`, `Liquidate`, `AccrueInterest`) filtered to Stockline market IDs, plus Vault V2 events, router events, oracle `GuardChanged` and wrapper multiplier changes. |
| SI-R2 | It stores per-position state (user, market, borrowShares, collateral) and per-market snapshots every block where state changed, plus 1-minute, 1-hour and 1-day rollups. |
| SI-R3 | Reorg-safe: data is marked `confirmed` after N blocks (N from chain finality: the `safe` tag trails head by ~11.5 min / ~6.9k blocks and `finalized` by ~18 min / ~11k blocks; blocks are ~0.1 s (verified Phase 0, 2026-09-26)). The API exposes the confirmation state. |
| SI-R4 | Head lag ≤ 3 blocks at p95. Backfill from Stockline deployment block completes in < 1 hour. |
| SI-R5 | A daily reconciliation job compares indexed totals with onchain `market()` reads and pages if they differ by more than 1 wei-equivalent after interest accrual. |

## 2. Public API

Base: `https://api.stockline.xyz/v1` (placeholder domain). JSON, times in ISO 8601 UTC, amounts as decimal strings.

| Endpoint | Returns |
|---|---|
| `GET /markets` | All stocks, current snapshot (all fields above) |
| `GET /markets/{symbol}` | One stock, current snapshot + params (LLTV, caps, `U_MAX`, buffer now, next session) |
| `GET /markets/{symbol}/history?interval=1m\|1h\|1d&from&to` | Time series of the snapshot fields |
| `GET /markets/{symbol}/events?type=borrow\|repay\|liquidate&cursor` | Event feed (paginated) |
| `GET /positions/{address}` | Positions for a wallet (public data) |
| `GET /status` | Oracle freshness, guard state, indexer lag per market |
| `WS /stream` | Subscribe `{"channel":"market","symbol":"NVDA"}` or `{"channel":"events","symbol":"*"}` |
| `GET /openapi.json` | OpenAPI 3.1 spec |

| ID | Requirement |
|---|---|
| SI-R10 | Free tier without a key: 60 req/min, 1 WS connection. Keyed tier: 600 req/min, 10 WS connections. Keys are self-serve, created by signing in with a wallet. |
| SI-R11 | p95 latency < 200ms for snapshot endpoints. WS pushes within 2s of the block. |
| SI-R12 | CSV export for history endpoints (`?format=csv`). |
| SI-R13 | Every response includes `asOfBlock`, `asOfTime` and `confirmed`. |
| SI-R14 | Terms of use: data provided as is, attribution requested, no warranty. |

## 3. Onchain lens

```solidity
interface IShortInterestLens {
    struct StockSnapshot {
        address stockToken;
        uint256 suppliedShares;     // 1e18, after multiplier
        uint256 borrowedShares;     // 1e18, after multiplier
        uint256 utilizationWad;     // 1e18 = 100%
        uint256 borrowRatePerSecWad;
        uint256 bufferWad;          // current weekend buffer
        bool    marketOpen;
        bool    guardTripped;
    }
    function snapshot(address stockToken) external view returns (StockSnapshot memory);
    function snapshotAll() external view returns (StockSnapshot[] memory);
}
```

| ID | Requirement |
|---|---|
| SI-R20 | The lens computes values with accrued interest up to `block.timestamp` (use `MorphoBalancesLib.expectedMarketBalances`). |
| SI-R21 | The lens is stateless and redeployable. Its registry of stocks is read from a `StocklineRegistry` or passed in at deployment. |

## 4. Dashboard (`/short-interest`)

- Leaderboard table: stock, short interest (shares, USD), % of float, utilization, borrow APR, 24h change, days to cover. Sortable.
- Per-stock chart: short interest (line) and borrow APR (line, second axis only if necessary) over time; weekends shaded.
- Weekend panel: current Stock Token DEX price vs Chainlink reference, premium %, buffer in force.
- "Built on this data" section with API docs link and code snippets (curl, TypeScript, Python).

## Acceptance criteria

- [ ] Indexer backfills testnet history and reconciles with zero diffs for 7 days.
- [ ] OpenAPI spec published. The SDK has a typed client generated from it.
- [ ] Dashboard numbers equal lens `snapshot()` output at the same block, checked by an automated test.
- [ ] Load test: 200 concurrent WS clients, 50 req/s REST, p95 within SI-R11.
