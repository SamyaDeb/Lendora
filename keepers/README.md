# keepers

TypeScript + viem. All math, ABIs and addresses come from `@stockline/sdk`. **Dry run is the default**: plans are
logged and nothing is sent unless `DRY_RUN=false` and a signer is configured. No key material lives in this repo.

| Keeper | Requirements | Run |
|---|---|---|
| Allocator | LM-R30…R34 (Vault V2 `allocate`/`deallocate`), D5 pre-earnings pull | `pnpm --filter @stockline/keepers allocator` |
| Guard | OR-R31 (30-min TWAP deviation), OR-R32 (`poke`), OR-R6 keeper side (L2 block gaps), D4 issuer flags | `pnpm --filter @stockline/keepers guard` |
| Fallback liquidator | 03 · liquidations via `StocklineLiquidator` | `pnpm --filter @stockline/keepers liquidator` |

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8545` | JSON-RPC endpoint |
| `DEPLOYMENT_KEY` | `31337` | Key in `packages/sdk/addresses.json` (`31337` or `fork-4663`) |
| `DRY_RUN` | `true` | `false` sends transactions |
| `KEEPER_SIGNER` | `dry-run` | `env-key` (reads `KEEPER_PRIVATE_KEY`, inject from a secret manager) or `rpc-unlocked` (anvil only) |
| `KEEPER_ADDRESS` | role from the address book | account for `rpc-unlocked` |
| `INTERVAL_MS` | `30000` | tick interval (every 30 s; Robinhood Chain blocks are ~0.1 s) |
| `HEALTH_PORT` | `8787` | `GET /health`: 200 if every market ran within `MAX_STALE_MS` (default 5 min, LM-R33), else 503 |

Every tick recomputes from chain state, so keepers are idempotent and restart-safe.

## Tests

`pnpm --filter @stockline/keepers test` starts anvil and loads `packages/devnet/fixtures/anvil-state.hex`: the task 7 deployment
(`contracts/script/DeployLocal.s.sol`, mocks for everything Robinhood Chain provides), matching `addresses.json["31337"]`.
Regenerate after redeploying: `pnpm --filter @stockline/devnet state:dump --rpc <anvil>`.
