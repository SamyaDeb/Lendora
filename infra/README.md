# infra

Deployment configuration for the Phase 2 services (02: Railway or similar; Postgres and Redis managed). **Nothing is
created or deployed from this repo without the owner's go.**

| Service | Image | Start | Health | Env template |
|---|---|---|---|---|
| indexer | `infra/Dockerfile`, `SERVICE=indexer` | `ponder start --views-schema lendora` | `GET /ready` (:42069) | `indexer/.env.example` |
| reconcile (daily cron, SI-R5) | `infra/Dockerfile`, `SERVICE=reconcile` | cron `15 3 * * *` | exit code | `indexer/.env.example` |
| api | `infra/Dockerfile`, `SERVICE=api` | Hono + WS | `GET /health` (:42070) | `api/.env.example` |
| compliance | `infra/Dockerfile`, `SERVICE=compliance` | signer | `GET /health` (:42071) | `compliance/.env.example` |
| alerts | `infra/Dockerfile`, `SERVICE=alerts` | watcher + settings API | `GET /health` (:42072) | `keepers/.env.example` |
| allocator, guard, liquidator, fee-converter | `infra/Dockerfile`, `SERVICE=<name>` | keeper loops (dry run by default) | `GET /health` (`HEALTH_PORT`) | `keepers/.env.example` |
| monitor (MON-R1…R14) | `infra/Dockerfile`, `SERVICE=monitor` | read-only ops monitor, pages P0/P1/P2, `GET /weekends`, `GET /incidents` | `GET /health` (:42073) | `keepers/.env.example` |
| dn-rebalancer, nav-reporter (Phase 4, DN-R2…R14) | `infra/Dockerfile`, `SERVICE=<name>` | vault keepers (dry run by default; strategy operator key / NAV signer key) | `GET /health` (`HEALTH_PORT`) | `keepers/.env.example` |
| nav-cosigner (Phase 4, DN-R4) | `infra/Dockerfile`, `SERVICE=nav-cosigner` | independent second NAV signer, `POST /cosign` (bearer `COSIGNER_TOKEN`); **run by a different operator with its own key and RPC** | `GET /health` | `keepers/.env.example` |
| feed-mirror (testnet) | `infra/Dockerfile`, `SERVICE=feed-mirror` | mainnet feeds → testnet mock feeds | `GET /health` | `keepers/.env.example` |
| venue-mirror (testnet, A49) | `infra/Dockerfile`, `SERVICE=venue-mirror` | Lighter's real hourly funding (public API) → the testnet mock perp venue | `GET /health` | `keepers/.env.example` |
| web | `infra/web.Dockerfile` (NEXT_PUBLIC_* as build args) | `next start` | `GET /restricted` | `web/.env.example` |

`infra/railway/<service>.json` is Railway config-as-code for each service (Dockerfile path, health check, restart
policy). Secrets (keys, API tokens, database URLs) are set in the platform's secret store, never in the repo.
Geo headers (CP-R8): put the web app behind a platform that sets the visitor's country and IP (Vercel or Cloudflare),
set `GEO_PLATFORM=vercel|cloudflare` on web, and share one `PROXY_SECRET` (≥ 32 random chars, e.g.
`openssl rand -hex 32`) between web and compliance. The web proxy forwards only that platform's headers, normalized,
and drops anything the browser sent; compliance trusts geo/IP headers only with the secret and **refuses to start
without it** on every network except anvil (31337). Railway config-as-code (`infra/railway/*.json`) cannot hold
environment variables, so the required ones per service are listed here and set in the platform's secret store:

| Service | Required env (besides `DATABASE_URL` / `RPC_URL`) |
|---|---|
| compliance | `LENDORA_NETWORK`, `COMPLIANCE_SIGNER_KEY` (or remote signer), `PROXY_SECRET`, `TRUST_PROXY=true`, `ALLOWED_ORIGINS`, `SANCTIONS_PROVIDER` + `SANCTIONS_API_KEY` (mainnet refuses `deny-list`), `ATTEST_RPM` (per IP and per wallet) |
| web | `COMPLIANCE_URL`, `PROXY_SECRET` (same value), `GEO_PLATFORM`, `API_URL_INTERNAL`, `ALERTS_URL`, `NEXT_PUBLIC_*` build args |
| monitor | `DATABASE_URL` (same Postgres as the indexer), `INDEXER_SCHEMA`, `MONITOR_KEEPERS`, `MONITOR_GAS_WATCH` + `GAS_BURN_WEI_PER_DAY` (MON-R15), one pager at least (`PAGERDUTY_ROUTING_KEY` or `OPSGENIE_API_KEY`; Telegram/webhook optional) |
