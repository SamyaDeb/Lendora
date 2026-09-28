#!/usr/bin/env bash
# The whole Stockline stack on one machine, offline (Phase 2 task 0).
#
#   scripts/dev.sh                 # Postgres + Redis, anvil, DeployLocal, compliance signer, all services
#   scripts/dev.sh --fixture       # load the DeployLocal fixture instead of deploying (seconds instead of a minute)
#   scripts/dev.sh --seed          # also run the chain driver's seed week before the services start
#   scripts/dev.sh --infra-only    # stop after Postgres, Redis, anvil and the signer (run services yourself)
#   scripts/dev.sh --network 46630 [--stop|--status]   # the services against Robinhood Chain testnet (dev-testnet.sh)
#
# Infra: docker-compose (postgres, redis) when Docker works, else local `postgres` / `redis-server` binaries with data
# in .dev/ (STOCKLINE_INFRA=docker|native forces one). Anvil is always the local binary on :8545 so `forge script`
# can deploy to it. Nothing here touches a real chain: the RPC is checked to be 31337.
#
# Secrets: none in the repo. The compliance signer key is generated on first run into .dev/compliance.key (gitignored)
# and installed on the router through the (impersonated) timelock.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Testnet mode lives in its own script (no anvil, no deploy, detached services); everything below is anvil-only.
for a in "$@"; do case "$a" in --network|--network=*) exec "$ROOT/scripts/dev-testnet.sh" "$@" ;; esac; done
DEV="$ROOT/.dev"
mkdir -p "$DEV/logs"
ANVIL_PORT="${STOCKLINE_ANVIL_PORT:-8545}"
PG_PORT="${STOCKLINE_PG_PORT:-55432}"
REDIS_PORT="${STOCKLINE_REDIS_PORT:-56379}"
RPC="http://127.0.0.1:$ANVIL_PORT"
FIXTURE=0 SEED=0 INFRA_ONLY=0
for a in "$@"; do
  case "$a" in
    --fixture) FIXTURE=1 ;;
    --seed) SEED=1 ;;
    --infra-only) INFRA_ONLY=1 ;;
    *) echo "unknown flag $a" >&2; exit 1 ;;
  esac
done

PIDS=()
cleanup() {
  echo "[dev] stopping"
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  if [ "${INFRA:-}" = native ]; then
    pg_ctl -D "$DEV/pg" stop -m fast >/dev/null 2>&1 || true
    redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- Postgres + Redis
. "$ROOT/scripts/lib/infra.sh"
dev_infra

# ---------------------------------------------------------------- anvil + deployment
if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "[dev] anvil already running on $RPC"
else
  if [ "$FIXTURE" = 1 ]; then
    pnpm --silent --filter @stockline/devnet drive serve --port "$ANVIL_PORT" >"$DEV/logs/anvil.log" 2>&1 &
    PIDS+=($!)
  else
    anvil --port "$ANVIL_PORT" --silent >"$DEV/logs/anvil.log" 2>&1 &
    PIDS+=($!)
  fi
  until cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; do sleep 0.2; done
  if [ "$FIXTURE" = 1 ]; then
    until [ "$(cast code "$(node -e "console.log(require('$ROOT/packages/sdk/addresses.json').chains['31337'].router)")" --rpc-url "$RPC")" != 0x ]; do sleep 0.3; done
  else
    echo "[dev] deploying (DeployLocal → packages/sdk/addresses.json[\"31337\"])"
    (cd "$ROOT/contracts" && forge script script/DeployLocal.s.sol --rpc-url "$RPC" --broadcast --slow --unlocked \
      --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 >"$DEV/logs/deploy.log" 2>&1)
  fi
fi
[ "$(cast chain-id --rpc-url "$RPC")" = 31337 ] || { echo "[dev] $RPC is not anvil (31337); refusing" >&2; exit 1; }

# ---------------------------------------------------------------- compliance signer (RT-R2), generated locally
ROUTER="$(node -e "console.log(require('$ROOT/packages/sdk/addresses.json').chains['31337'].router)")"
if [ ! -f "$DEV/compliance.key" ]; then
  cast wallet new --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].private_key))" >"$DEV/compliance.key"
  chmod 600 "$DEV/compliance.key"
fi
SIGNER="$(cast wallet address --private-key "$(cat "$DEV/compliance.key")")"
OWNER="$(cast call "$ROUTER" "owner()(address)" --rpc-url "$RPC")"
cast rpc anvil_impersonateAccount "$OWNER" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance "$OWNER" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
cast send --unlocked --from "$OWNER" "$ROUTER" "setAttestationSigner(address)" "$SIGNER" --rpc-url "$RPC" >/dev/null
echo "[dev] compliance signer $SIGNER installed on the router"

cat >"$DEV/env" <<EOF
RPC_URL=$RPC
DEPLOYMENT_KEY=31337
DATABASE_URL=$DATABASE_URL
REDIS_URL=$REDIS_URL
COMPLIANCE_SIGNER_KEY_FILE=$DEV/compliance.key
INDEXER_SCHEMA=stockline_dev
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_RPC_URL=$RPC
NEXT_PUBLIC_API_URL=http://127.0.0.1:42070
COMPLIANCE_URL=http://127.0.0.1:42071
ALERTS_URL=http://127.0.0.1:42072
EOF
echo "[dev] wrote $DEV/env"

if [ "$SEED" = 1 ]; then
  echo "[dev] seeding a week of activity (chain driver)"
  pnpm --silent --filter @stockline/devnet drive seed --rpc "$RPC" >"$DEV/logs/seed.log" 2>&1
  tail -1 "$DEV/logs/seed.log"
fi

[ "$INFRA_ONLY" = 1 ] && { echo "[dev] infra ready; Ctrl-C to stop"; wait; exit 0; }

# ---------------------------------------------------------------- services (each has a `dev` script once built)
set -a; . "$DEV/env"; set +a
export KEEPER_SIGNER=rpc-unlocked DRY_RUN=false
start() { # name, pnpm filter, script
  if node -e "process.exit(require('$ROOT/$2/package.json').scripts?.['$3'] ? 0 : 1)" 2>/dev/null; then
    (cd "$ROOT/$2" && pnpm --silent run "$3") >"$DEV/logs/$1.log" 2>&1 &
    PIDS+=($!)
    echo "[dev] $1 → .dev/logs/$1.log"
  fi
}
start driver packages/devnet drive:live
start indexer indexer dev
start api api dev
DEV_DEFAULT_COUNTRY=DE PORT=42071 start compliance compliance dev
start web web dev
HEALTH_PORT=8787 start allocator keepers allocator
HEALTH_PORT=8788 start guard keepers guard
start alerts keepers alerts
# Ops monitor (MON-R1…R14): read-only; pages to the console locally. GET :42073/weekends, /incidents.
PORT=42073 MONITOR_KEEPERS="allocator=http://127.0.0.1:8787/health,guard=http://127.0.0.1:8788/health,alerts=http://127.0.0.1:42072/health" \
  start monitor keepers monitor
echo "[dev] up. web http://localhost:3000 · api http://localhost:42070/v1 · indexer http://localhost:42069 · monitor http://localhost:42073/weekends · Ctrl-C stops everything"
wait
