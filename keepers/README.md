# keepers

TypeScript + viem. All math, ABIs and addresses come from `@stockline/sdk`. **Dry run is the default**: plans are
logged and nothing is sent unless `DRY_RUN=false` and a signer is configured. No key material lives in this repo.

| Keeper | Requirements | Run |
|---|---|---|
| Allocator | LM-R30…R34 (Vault V2 `allocate`/`deallocate`), D5 pre-earnings pull | `pnpm --filter @stockline/keepers allocator` |
| Guard | OR-R31 (30-min TWAP deviation), OR-R32 (`poke`), OR-R6 keeper side (L2 block gaps), D4 issuer flags | `pnpm --filter @stockline/keepers guard` |
| Fallback liquidator | 03 · liquidations via `StocklineLiquidator` | `pnpm --filter @stockline/keepers liquidator` |
| Alerts (Phase 2) | APP-R8: HF below the wallet's threshold; 24h and 4h before a weekend or earnings ramp-in when HF at the full buffer < 1.2. Email (Resend), Telegram, signed webhooks behind a `Transport` interface; settings saved from `/alerts` with a signed message | `pnpm --filter @stockline/keepers alerts` |

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

Every tick recomputes from chain state, so keepers are idempotent and restart-safe. The alerts service also claims
every alert instance in Postgres before sending it (no duplicates across restarts; a failed delivery is retried).

Alerts env: `DATABASE_URL`, `INDEXER_SCHEMA` (indexer views, for positions), `ALERTS_SCHEMA`, `PORT` (42072),
`ALERTS_INTERVAL_MS` (5000), `RESEND_API_KEY` + `ALERTS_EMAIL_FROM`, `TELEGRAM_BOT_TOKEN`, `ALERTS_WEBHOOK_SIGNING_KEY`
(HMAC `x-stockline-signature`), `ALERTS_ALLOW_PRIVATE_WEBHOOKS` (dev only). Measured on anvil: alert delivered ~0.5 s
after the triggering block (target < 60 s).

## Tests

`pnpm --filter @stockline/keepers test` starts anvil and loads `packages/devnet/fixtures/anvil-state.hex`: the task 7 deployment
(`contracts/script/DeployLocal.s.sol`, mocks for everything Robinhood Chain provides), matching `addresses.json["31337"]`.
Regenerate after redeploying: `pnpm --filter @stockline/devnet state:dump --rpc <anvil>`.
