# infra

Deployment configuration for the Phase 2 services (02: Railway or similar; Postgres and Redis managed). **Nothing is
created or deployed from this repo without the owner's go.**

| Service | Image | Start | Health | Env template |
|---|---|---|---|---|
| indexer | `infra/Dockerfile`, `SERVICE=indexer` | `ponder start --views-schema stockline` | `GET /ready` (:42069) | `indexer/.env.example` |
| reconcile (daily cron, SI-R5) | `infra/Dockerfile`, `SERVICE=reconcile` | cron `15 3 * * *` | exit code | `indexer/.env.example` |
| api | `infra/Dockerfile`, `SERVICE=api` | Hono + WS | `GET /health` (:42070) | `api/.env.example` |
| compliance | `infra/Dockerfile`, `SERVICE=compliance` | signer | `GET /health` (:42071) | `compliance/.env.example` |
| alerts | `infra/Dockerfile`, `SERVICE=alerts` | watcher + settings API | `GET /health` (:42072) | `keepers/.env.example` |
| allocator, guard, liquidator | `infra/Dockerfile`, `SERVICE=<name>` | keeper loops (dry run by default) | `GET /health` (`HEALTH_PORT`) | `keepers/.env.example` |
| feed-mirror (testnet) | `infra/Dockerfile`, `SERVICE=feed-mirror` | mainnet feeds → testnet mock feeds | `GET /health` | `keepers/.env.example` |
| web | `infra/web.Dockerfile` (NEXT_PUBLIC_* as build args) | `next start` | `GET /restricted` | `web/.env.example` |

`infra/railway/<service>.json` is Railway config-as-code for each service (Dockerfile path, health check, restart
policy). Secrets (keys, API tokens, database URLs) are set in the platform's secret store, never in the repo.
Geo headers: put the web app behind a platform that sets `x-vercel-ip-country` / `cf-ipcountry` (Vercel or
Cloudflare) and share `PROXY_SECRET` between web and compliance.
