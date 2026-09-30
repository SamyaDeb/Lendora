#!/usr/bin/env bash
# Every Stockline backend service on this machine against Robinhood Chain testnet (46630), plus the web app.
#
#   scripts/dev.sh --network 46630            # start (idempotent: running services are left alone)
#   scripts/dev.sh --network 46630 --status   # pid + health per service
#   scripts/dev.sh --network 46630 --stop     # stop the services (Postgres and Redis keep running)
#   scripts/dev.sh --network 46630 --read-only  # indexer, API and monitor only: no keys needed (observer)
#
# Only Postgres and Redis run locally: no anvil, no deploy. The deployment is packages/sdk/addresses.json["46630"].
# Services run detached (own process group, pid in .dev/run/, log in .dev/logs/<name>.log) and survive this script.
# Restart-safe: the indexer resumes its schema (stockline_46630) instead of backfilling from startBlock again.
#
# Env: repo-root .env (ROBINHOOD_TESTNET_RPC_URL, ROBINHOOD_MAINNET_READ_RPC_URL) and, exported by the owner,
# TESTNET_DEPLOYER_KEY (keepers), COMPLIANCE_SIGNER_KEY (compliance) and PROXY_SECRET (compliance + web). Secrets reach
# the services only through their environment; this script never prints or writes them. Phase 4 (once the book has
# `dnVault`): NAV_COSIGNER_KEY (the second NAV signer, testnet-only key) and COSIGNER_TOKEN (>= 32 chars).
# Optional: STOCKLINE_SERVICES_RPC_URL (the services' RPC; default ROBINHOOD_TESTNET_RPC_URL — a free-tier provider
# that caps eth_getLogs, e.g. Alchemy's 10 blocks, breaks the indexer, monitor and DN keepers: use the public endpoint
# https://rpc.testnet.chain.robinhood.com or a paid plan), INDEXER_RPC_URL (the indexer's own 46630 RPC, T3; default the
# services' RPC), GEO_STATIC_COUNTRY (web, default DE), STOCKLINE_WEB_RPC_URL (browser RPC, default the public endpoint),
# SANCTIONS_DENY_LIST (default: the `sanctioned` test user in .dev/testnet-users.json), GAS_BURN_WEI_PER_DAY.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV="$ROOT/.dev"
RUN="$DEV/run"
mkdir -p "$DEV/logs" "$RUN"
PG_PORT="${STOCKLINE_PG_PORT:-55432}"
REDIS_PORT="${STOCKLINE_REDIS_PORT:-56379}"
NETWORK="" MODE=start READ_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --network) NETWORK="${2:-}"; shift ;;
    --network=*) NETWORK="${1#*=}" ;;
    --stop) MODE=stop ;;
    --status) MODE=status ;;
    --read-only) READ_ONLY=1 ;;
    *) echo "unknown flag $1" >&2; exit 1 ;;
  esac
  shift
done
[ "$NETWORK" = 46630 ] || { echo "[dev] only --network 46630 is supported (never mainnet 4663)" >&2; exit 1; }

# name|health URL (the service's own /health or /ready)
SERVICES=(
  "indexer|http://127.0.0.1:42069/ready"
  "api|http://127.0.0.1:42070/health"
  "compliance|http://127.0.0.1:42071/health"
  "alerts|http://127.0.0.1:42072/health"
  "allocator|http://127.0.0.1:8787/health"
  "guard|http://127.0.0.1:8788/health"
  "liquidator|http://127.0.0.1:8789/health"
  "feed-mirror|http://127.0.0.1:8790/health"
  "fee-converter|http://127.0.0.1:8791/health"
  "nav-cosigner|http://127.0.0.1:8795/health"
  "nav-reporter|http://127.0.0.1:8793/health"
  "dn-rebalancer|http://127.0.0.1:8792/health"
  "venue-mirror|http://127.0.0.1:8796/health"
  "monitor|http://127.0.0.1:42073/health"
  "web|http://127.0.0.1:3000/restricted"
)

LOGS="$DEV/logs"
# shellcheck disable=SC1091
. "$ROOT/scripts/lib/detached.sh"
alive() { detached_alive "$1"; }
code() { curl -s -o /dev/null -m 3 -w '%{http_code}' "$1" 2>/dev/null || true; }

status() {
  printf '%-12s %-8s %-6s %s\n' service pid http url
  for s in "${SERVICES[@]}"; do
    local n="${s%%|*}" u="${s#*|}" pid=-
    alive "$n" && pid="$(cat "$RUN/$n.pid")"
    printf '%-12s %-8s %-6s %s\n' "$n" "$pid" "$(code "$u")" "$u"
  done
}

stop() {
  for s in "${SERVICES[@]}"; do detached_stop "${s%%|*}"; done
}

case "$MODE" in
  status) status; exit 0 ;;
  stop) stop; exit 0 ;;
esac

# ---------------------------------------------------------------- env + checks
set -a
# shellcheck disable=SC1091
[ -f "$ROOT/.env" ] && . "$ROOT/.env"
set +a
required=(ROBINHOOD_TESTNET_RPC_URL)
[ "$READ_ONLY" = 1 ] || required+=(ROBINHOOD_MAINNET_READ_RPC_URL TESTNET_DEPLOYER_KEY COMPLIANCE_SIGNER_KEY PROXY_SECRET)
missing=()
for v in "${required[@]}"; do [ -n "${!v:-}" ] || missing+=("$v"); done
if [ ${#missing[@]} -gt 0 ]; then echo "[dev] missing env: ${missing[*]} (export them; see docs/runbooks/testnet.md §2)" >&2; exit 1; fi
RPC="${STOCKLINE_SERVICES_RPC_URL:-$ROBINHOOD_TESTNET_RPC_URL}"
[ "$(cast chain-id --rpc-url "$RPC")" = 46630 ] || { echo "[dev] the services' RPC is not chain 46630; refusing" >&2; exit 1; }

addr() { node -e "const d=require('$ROOT/packages/sdk/addresses.json').chains['46630'];console.log($1)"; }
START_BLOCK="$(addr d.startBlock)"
OPERATOR="$(addr d.roles.allocator)"
if [ "$READ_ONLY" = 0 ]; then
  [ ${#PROXY_SECRET} -ge 32 ] || { echo "[dev] PROXY_SECRET must be >= 32 chars" >&2; exit 1; }
  [ "$(cast chain-id --rpc-url "$ROBINHOOD_MAINNET_READ_RPC_URL")" = 4663 ] || { echo "[dev] ROBINHOOD_MAINNET_READ_RPC_URL is not chain 4663 (feed mirror source)" >&2; exit 1; }
  # Addresses derived from the keys inside node (keys never appear on a command line).
  key_address() { (cd "$ROOT/keepers" && node --input-type=module -e "import {privateKeyToAccount} from 'viem/accounts';console.log(privateKeyToAccount(process.env.$1).address)"); }
  KEY_ADDR="$(key_address TESTNET_DEPLOYER_KEY)"
  SIGNER="$(key_address COMPLIANCE_SIGNER_KEY)"
  ONCHAIN_SIGNER="$(cast call "$(addr d.router)" 'attestationSigner()(address)' --rpc-url "$RPC")"
  lc() { echo "$1" | tr A-F a-f; }
  [ "$(lc "$SIGNER")" = "$(lc "$ONCHAIN_SIGNER")" ] || { echo "[dev] COMPLIANCE_SIGNER_KEY is $SIGNER but the router expects $ONCHAIN_SIGNER; refusing" >&2; exit 1; }
  [ "$(lc "$KEY_ADDR")" = "$(lc "$OPERATOR")" ] || { echo "[dev] TESTNET_DEPLOYER_KEY is $KEY_ADDR, not the allocator/guard role holder $OPERATOR; refusing" >&2; exit 1; }
  DENY_LIST="${SANCTIONS_DENY_LIST:-$( [ -f "$DEV/testnet-users.json" ] && node -e "console.log(require('$DEV/testnet-users.json').sanctioned?.address ?? '')" || true)}"
  echo "[dev] testnet 46630 · operator $OPERATOR · compliance signer $SIGNER · startBlock $START_BLOCK"
else
  echo "[dev] testnet 46630 READ-ONLY (indexer, api, monitor) · startBlock $START_BLOCK"
fi

. "$ROOT/scripts/lib/infra.sh"
dev_infra

# ---------------------------------------------------------------- services
# start <name> <dir> [NAME=value ...] -- <cmd...>: detached in its own process group (scripts/lib/detached.sh).
start() { detached_start "$@"; }
TSX="$ROOT/node_modules/.bin/tsx"
[ -x "$TSX" ] || TSX="$ROOT/keepers/node_modules/.bin/tsx"
# pnpm hoists the binaries to the root; a package-local .bin is used when it exists.
bin() { if [ -x "$ROOT/$1/node_modules/.bin/$2" ]; then echo "./node_modules/.bin/$2"; else echo "$ROOT/node_modules/.bin/$2"; fi; }
pnpm --silent --filter @stockline/sdk build >/dev/null

# Reads pinned to past blocks (indexer snapshots, the NAV co-signer's checks) fall back to ROBINHOOD_TESTNET_RPC_URL
# when the services use another RPC: the public endpoint keeps no historical state (A24).
ARCHIVE=""; [ "$RPC" = "$ROBINHOOD_TESTNET_RPC_URL" ] || ARCHIVE="$ROBINHOOD_TESTNET_RPC_URL"
COMMON=(STOCKLINE_NETWORK=46630 DEPLOYMENT_KEY=46630 RPC_URL="$RPC" RPC_URL_ARCHIVE="$ARCHIVE" DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL")
INDEXER_VIEWS=stockline_testnet

# T3: INDEXER_RPC_URL (optional) is the indexer's own RPC budget, not shared with the keepers: a catch-up after an
# outage on the shared endpoint hits 429s and Ponder's limiter pins at 3 req/s. Pinned reads still fall back to the
# archive endpoint (ROBINHOOD_TESTNET_RPC_URL) when the indexer's RPC is another one (A24).
# T16/T17: under scripts/lib/supervise.sh, restarted when Ponder exits (it does when every RPC fails) and with RPC URL
# paths redacted from its log (Ponder prints the URL with its key).
IDX_RPC="${INDEXER_RPC_URL:-$RPC}"
IDX_ARCHIVE=""; [ "$IDX_RPC" = "$ROBINHOOD_TESTNET_RPC_URL" ] || IDX_ARCHIVE="$ROBINHOOD_TESTNET_RPC_URL"
if [ -n "${INDEXER_RPC_URL:-}" ]; then
  [ "$(cast chain-id --rpc-url "$INDEXER_RPC_URL")" = 46630 ] || { echo "[dev] INDEXER_RPC_URL is not chain 46630; refusing" >&2; exit 1; }
  echo "[dev] indexer on its own RPC (INDEXER_RPC_URL)"
else
  echo "[dev] indexer shares the services' RPC (INDEXER_RPC_URL unset; see docs/runbooks/testnet.md §2)"
fi
start indexer indexer "${COMMON[@]}" RPC_URL="$IDX_RPC" RPC_URL_ARCHIVE="$IDX_ARCHIVE" PONDER_POLLING_MS="${PONDER_POLLING_MS:-1000}" \
  -- "$ROOT/scripts/lib/supervise.sh" "$(bin indexer ponder)" start --schema stockline_46630 --views-schema "$INDEXER_VIEWS" --port 42069
start api api "${COMMON[@]}" INDEXER_SCHEMA="$INDEXER_VIEWS" API_SCHEMA=stockline_api_testnet PORT=42070 SIWE_DOMAIN=localhost:3000 \
  -- "$TSX" src/index.ts
if [ "$READ_ONLY" = 0 ]; then
start compliance compliance "${COMMON[@]}" COMPLIANCE_SCHEMA=stockline_compliance_testnet PORT=42071 TRUST_PROXY=true \
  SANCTIONS_PROVIDER=deny-list SANCTIONS_DENY_LIST="$DENY_LIST" ALLOWED_ORIGINS=http://localhost:3000 \
  -- "$TSX" src/index.ts
# Keepers: live on testnet with the operator key (KEEPER_PRIVATE_KEY is read only by the env-key signer).
KEEPER=("${COMMON[@]}" DRY_RUN=false KEEPER_SIGNER=env-key KEEPER_PRIVATE_KEY="$TESTNET_DEPLOYER_KEY" INDEXER_SCHEMA="$INDEXER_VIEWS")
start allocator keepers "${KEEPER[@]}" HEALTH_PORT=8787 \
  -- "$TSX" src/allocator/main.ts
start guard keepers "${KEEPER[@]}" HEALTH_PORT=8788 \
  -- "$TSX" src/guard/main.ts
start liquidator keepers "${KEEPER[@]}" HEALTH_PORT=8789 LIQUIDATOR_FROM_BLOCK="$START_BLOCK" \
  -- "$TSX" src/liquidator/main.ts
start feed-mirror keepers "${KEEPER[@]}" HEALTH_PORT=8790 MAINNET_RPC_URL="$ROBINHOOD_MAINNET_READ_RPC_URL" INTERVAL_MS=15000 \
  -- "$TSX" src/feedMirror/main.ts
HAS_FEES="$(addr "d.feeSplitter ? 1 : ''")"
HAS_DN="$(addr "d.dnVault ? 1 : ''")"
# FE-R4: the fee converter as the fee keeper (the operator key on testnet, A27).
[ -z "$HAS_FEES" ] || start fee-converter keepers "${KEEPER[@]}" HEALTH_PORT=8791 INTERVAL_MS=60000 FEE_CONVERTER_FROM_BLOCK="$START_BLOCK" \
  -- "$TSX" src/feeConverter/main.ts
if [ -n "$HAS_DN" ]; then
  # Phase 4 (08): NAV reporter (signer 1 = the operator key) with an independent co-signer (signer 2, its own key),
  # the rebalancer as the strategy operator, and the venue mirror: Lighter's real hourly funding → the mock venue (A49).
  for v in NAV_COSIGNER_KEY COSIGNER_TOKEN; do [ -n "${!v:-}" ] || { echo "[dev] missing env: $v (the book has dnVault)" >&2; exit 1; }; done
  start nav-cosigner keepers "${COMMON[@]}" NAV_MODE=cosigner PORT=8794 HEALTH_PORT=8795 NAV_SIGNER_SIGNER=env-key \
    NAV_SIGNER_KEY="$NAV_COSIGNER_KEY" COSIGNER_TOKEN="$COSIGNER_TOKEN" \
    -- "$TSX" src/navReporter/main.ts
  start nav-reporter keepers "${KEEPER[@]}" HEALTH_PORT=8793 NAV_SIGNER_SIGNER=env-key NAV_SIGNER_KEY="$TESTNET_DEPLOYER_KEY" \
    COSIGNER_URL=http://127.0.0.1:8794/cosign COSIGNER_TOKEN="$COSIGNER_TOKEN" \
    -- "$TSX" src/navReporter/main.ts
  # T14: the testnet book (~$150) is under the $100-per-trade default once split into sleeves: 10 USDG lets it deploy.
  start dn-rebalancer keepers "${KEEPER[@]}" HEALTH_PORT=8792 DN_VENUE=mock DN_MIN_TRADE_USDG="${DN_MIN_TRADE_USDG:-10000000}" \
    -- "$TSX" src/dnRebalancer/main.ts
  start venue-mirror keepers "${KEEPER[@]}" HEALTH_PORT=8796 INTERVAL_MS=300000 \
    -- "$TSX" src/venueMirror/main.ts
fi
start alerts keepers "${COMMON[@]}" DRY_RUN=false KEEPER_SIGNER=env-key INDEXER_SCHEMA="$INDEXER_VIEWS" ALERTS_SCHEMA=stockline_alerts_testnet PORT=42072 \
  -- "$TSX" src/alerts/main.ts
fi
MONITOR_KEEPERS=""
if [ "$READ_ONLY" = 0 ]; then
  MONITOR_KEEPERS="allocator=http://127.0.0.1:8787/health,guard=http://127.0.0.1:8788/health,liquidator=http://127.0.0.1:8789/health,feed-mirror=http://127.0.0.1:8790/health,alerts=http://127.0.0.1:42072/health"
  [ -z "$HAS_FEES" ] || MONITOR_KEEPERS+=",fee-converter=http://127.0.0.1:8791/health"
  [ -z "$HAS_DN" ] || MONITOR_KEEPERS+=",dn-rebalancer=http://127.0.0.1:8792/health,nav-reporter=http://127.0.0.1:8793/health,nav-cosigner=http://127.0.0.1:8795/health,venue-mirror=http://127.0.0.1:8796/health"
fi
# Ops monitor: read-only; pages to the console (its log) and .dev/pages.jsonl until a real pager is configured.
start monitor keepers "${COMMON[@]}" INDEXER_SCHEMA="$INDEXER_VIEWS" MONITOR_SCHEMA=stockline_monitor_testnet PORT=42073 \
  MONITOR_KEEPERS="$MONITOR_KEEPERS" \
  MONITOR_GAS_WATCH="operator=$OPERATOR" GAS_BURN_WEI_PER_DAY="${GAS_BURN_WEI_PER_DAY:-1200000000000000}" \
  MONITOR_PAGE_FILE="$DEV/pages.jsonl" \
  -- "$TSX" src/monitor/main.ts
[ "$READ_ONLY" = 1 ] || start web web NODE_ENV=development NEXT_PUBLIC_CHAIN_ID=46630 NEXT_PUBLIC_RPC_URL="${STOCKLINE_WEB_RPC_URL:-https://rpc.testnet.chain.robinhood.com}" \
  NEXT_PUBLIC_API_URL=http://127.0.0.1:42070 API_URL_INTERNAL=http://127.0.0.1:42070 COMPLIANCE_URL=http://127.0.0.1:42071 \
  NEXT_PUBLIC_FEATURE_VAULT="${HAS_DN:+1}" NEXT_PUBLIC_FEATURE_RECEIPT_MARKET="${NEXT_PUBLIC_FEATURE_RECEIPT_MARKET:-}" \
  ALERTS_URL=http://127.0.0.1:42072 GEO_PLATFORM=static GEO_STATIC_COUNTRY="${GEO_STATIC_COUNTRY:-DE}" \
  -- "$(bin web next)" dev -p 3000

# ---------------------------------------------------------------- health summary
echo "[dev] waiting for health (up to ${STOCKLINE_HEALTH_WAIT:-120} s; the indexer's /ready waits for its backfill)"
deadline=$(( $(date +%s) + ${STOCKLINE_HEALTH_WAIT:-120} ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  bad=0
  for s in "${SERVICES[@]}"; do alive "${s%%|*}" && { [ "$(code "${s#*|}")" = 200 ] || bad=$((bad + 1)); }; done
  [ "$bad" = 0 ] && break
  sleep 3
done
status
echo "[dev] web http://localhost:3000 · api http://localhost:42070/v1 · monitor http://localhost:42073/incidents · pages .dev/pages.jsonl"
echo "[dev] stop: scripts/dev.sh --network 46630 --stop"
