#!/usr/bin/env bash
# indexer-lag-check.sh: the supervisor's health check for the indexer (T41). Fails (exit 1) only when the indexer is
# more than INDEXER_MAX_LAG blocks (default 3000, ~12 min on 46630) behind the chain AND not catching up (the lag did
# not shrink by 500 blocks since the previous check). A restart re-enters Ponder's ranged catch-up; a long realtime
# backlog on a throttled RPC never closes (2026-10-02: 151k blocks behind, ~180 indexed/min vs ~240 produced).
# Can't tell (Ponder or the RPC unreachable): passes; a dead indexer is restarted by the exit path already.
# Env: RPC_URL (never printed), PONDER_URL (default http://127.0.0.1:42069), INDEXER_LAG_STATE (previous lag).
set -uo pipefail
max="${INDEXER_MAX_LAG:-3000}"
state="${INDEXER_LAG_STATE:-${TMPDIR:-/tmp}/indexer-lag.state}"
idx=$(curl -s -m 5 "${PONDER_URL:-http://127.0.0.1:42069}/status" | grep -o '"number":[0-9]*' | head -1 | cut -d: -f2)
hex=$(curl -s -m 5 -X POST "${RPC_URL:-}" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' 2>/dev/null | grep -o '"result":"0x[0-9a-fA-F]*"' | cut -d'"' -f4)
{ [ -n "$idx" ] && [ -n "$hex" ]; } || exit 0
lag=$(( 16#${hex#0x} - idx ))
prev=$(cat "$state" 2>/dev/null || echo "$lag")
echo "$lag" > "$state"
[ "$lag" -le "$max" ] && exit 0
[ "$lag" -lt $(( prev - 500 )) ] && exit 0
exit 1
