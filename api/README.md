# api

Stockline public short-interest API (docs/prd/07 §2, SI-R10…R14): Hono over the indexer's Postgres views, Redis for
rate limits and WebSocket fan-out. Every number comes from `@stockline/sdk` (indexer snapshots computed by
`shortInterestFields`; positions by `healthFactor` / `liquidationPrice`).

| Endpoint | |
|---|---|
| `GET /v1/markets` | All stocks, current snapshot (07 §Definitions) |
| `GET /v1/markets/{symbol}` | Snapshot + params (LLTV, caps, `U_MAX`, oracle params), buffer now, next close / ramp-in / reopen, buffer at close, next event, contracts |
| `GET /v1/markets/{symbol}/history?interval=1m\|1h\|1d&from&to[&format=csv]` | Rollups with flows (SI-R12 CSV) |
| `GET /v1/markets/{symbol}/events?type=borrow\|repay\|liquidate\|all&cursor&limit` | Event feed, newest first |
| `GET /v1/positions/{address}` | Positions with debt, HF and liquidation price |
| `GET /v1/status` | Oracle freshness, guard state, indexer lag |
| `WS /v1/stream` | `{"channel":"market","symbol":"NVDA"}` / `{"channel":"events","symbol":"*"}` |
| `GET /v1/auth/nonce`, `POST /v1/auth/keys`, `GET /v1/auth/keys`, `DELETE /v1/auth/keys/{id}` | Self-serve keys via Sign-In with Ethereum (SI-R10) |
| `GET /v1/terms` | Data terms (SI-R14); every response has `X-Data-Terms` |
| `GET /v1/openapi.json` | OpenAPI 3.1 (generated from the zod route schemas) |

Every data response carries `asOfBlock`, `asOfTime`, `confirmed` (block ≤ `finalized`, A23) and `safe`, in the body
and as `X-As-Of-*` headers (SI-R13). Limits (SI-R10): free 60 req/min + 1 WS connection per IP, keyed 600 req/min + 10
connections per key; headers `X-RateLimit-*`. API keys: only the SHA-256 of the key and the wallet address are stored.

## Typed client

`pnpm --filter @stockline/api openapi` writes `openapi.json` and regenerates `packages/sdk/src/api/schema.ts`
(openapi-typescript). The SDK exports the client as `api`:

```ts
import {api} from "@stockline/sdk";
const sl = api.createClient("https://api.stockline.xyz", {apiKey});
const {data, asOfBlock, confirmed} = await sl.markets();
```

## Run

```sh
pnpm --filter @stockline/api dev        # env: .env.example (scripts/dev.sh sets it up locally)
pnpm --filter @stockline/api test       # full stack on anvil: seed week → Ponder → Postgres → API
pnpm --filter @stockline/api loadtest   # SI-R11: 200 WS clients + 50 req/s; writes loadtest/results.md
```

Measured (local, see `loadtest/results.md`): REST p97.5 33 ms at 50 req/s; WS push p95 246 ms after the block with
200 clients (targets: p95 < 200 ms, < 2 s).
