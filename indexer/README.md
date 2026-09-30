# indexer

Ponder indexer for Lendora short-interest data (docs/prd/07 §1, SI-R1…R5) → Postgres. Addresses, ABIs and every
number (accrual, IRM rate, APR/APY, 07 §Definitions fields) come from `@lendora/sdk`.

| Req | Where |
|---|---|
| SI-R1 | `ponder.config.ts`: Morpho Blue events filtered to Lendora market ids, AdaptiveCurveIrm `BorrowRateUpdate` (same ids), Vault V2 (`rSTOCK`), router, oracle `GuardChanged`, Stock Token `UIMultiplierUpdated`, DEX swaps (mock aggregator on anvil/testnet, Uniswap v3 USDG/WETH pools on the fork) |
| SI-R2 | `ponder.schema.ts`: `market`, `position`, `snapshot` (every block where a stock's state changed, plus heartbeat blocks), `latest_snapshot`, `rollup` + `flow_bucket` (1m/1h/1d), `event_feed`, `dex_volume`. Fields computed by `shortInterestFields` (SDK) |
| SI-R3 | `chain_head`: indexed head plus the chain's `safe` / `finalized` blocks; the API marks data `confirmed` when its block ≤ `finalized` (Ponder itself rolls back reorged rows) |
| SI-R4 | Realtime polling 100 ms (anvil) / 200 ms (chains); oracle views read with one batched JSON-RPC request per snapshot |
| SI-R5 | `lib/reconcile.ts` + `scripts/reconcile.ts`: `market()`, `rateAtTarget`, vault idle and every position vs onchain at the indexed head; any diff > 1 wei pages through the `Pager` interface (`ConsolePager`, `WebhookPager` stub) |

Market totals and positions are derived from events exactly as Morpho Blue updates storage, so reconciliation is a
real check. Oracle/token views (buffer, guard reasons, feed answer, multiplier, token supply, `isOpen`) are read at
the snapshot block; on a node without that historical state (non-archive RPC, or anvil loaded from a state dump) the
snapshot falls back to the previous one or starts once reads succeed.

## Run

```sh
# anvil (scripts/dev.sh starts everything)
LENDORA_NETWORK=31337 RPC_URL=http://127.0.0.1:8545 DATABASE_URL=postgres://… pnpm --filter @lendora/indexer dev
# production-style (views for the API in schema "lendora"; DATABASE_SCHEMA = a per-deployment schema)
LENDORA_NETWORK=46630 RPC_URL=… DATABASE_URL=… DATABASE_SCHEMA=… pnpm --filter @lendora/indexer start
# SI-R5, daily
LENDORA_NETWORK=… RPC_URL=… DATABASE_URL=… [PAGER_WEBHOOK_URL=…] pnpm --filter @lendora/indexer reconcile
```

| Env | Default | Meaning |
|---|---|---|
| `LENDORA_NETWORK` | `31337` | `31337`, `fork-4663` or `46630` (never `4663` in Phase 2) |
| `RPC_URL` / `WS_URL` | anvil | JSON-RPC (archive recommended for exact historical snapshots) |
| `DATABASE_URL` | PGlite | Postgres |
| `PONDER_POLLING_MS` | 100 / 200 | realtime polling |
| `TICK_INTERVAL_BLOCKS` | 1 (anvil) / 600 (~1 min) | heartbeat snapshots |

## Tests and measurements

`pnpm --filter @lendora/indexer test`: anvil + the devnet seed week + a throwaway Postgres + `ponder start`.

Measured locally (Apple silicon, 2026-09-27, anvil, tick every block):

| Metric | Value | Target |
|---|---|---|
| Backfill of the seed week (641 blocks, ~720 events, ~2,600 snapshots) | 33 s | SI-R4 < 1 h for testnet history (checked for real on testnet) |
| Head lag at 10 blocks/s | p50 0, p95 1, max 1 block | SI-R4 p95 ≤ 3 |
| Reconciliation at head | 0 diffs over ~60 values | SI-R5 |
