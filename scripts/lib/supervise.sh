#!/usr/bin/env bash
# supervise.sh <cmd...>: run <cmd>, restart it whenever it exits, and redact URL paths from its output.
#
# T16: Ponder exits on an unhandled rejection when every RPC fails (46630, a DNS outage on the host): the indexer
# stayed down and the API fell 50k blocks behind until a manual restart. Ponder resumes from its checkpoint, so a
# restart is always safe. Backoff: SUPERVISE_DELAY_SEC (default 5), doubling up to 60 s, reset after 10 min up.
# T17: Ponder logs the failing RPC URL with its API key; our services redact themselves (OFF-1), Ponder does not.
# The same rule as @lendora/sdk redactSecrets: keep scheme and host, replace userinfo and path.
# Runs inside detached_start's process group, so detached_stop ends the loop and the service together.
set -uo pipefail
[ $# -gt 0 ] || { echo "usage: supervise.sh <cmd...>" >&2; exit 2; }
redact() { perl -pe 'BEGIN { $| = 1 } s#\b((?:https?|wss?)://)(?:[^\s/"@]*@)?([^\s/"?\#]+)[/?\#][^\s"]*#$1$2/[redacted]#g'; }
base="${SUPERVISE_DELAY_SEC:-5}"
delay="$base"
while :; do
  started=$(date +%s)
  "$@" 2>&1 | redact
  code=${PIPESTATUS[0]}
  [ $(( $(date +%s) - started )) -ge 600 ] && delay="$base"
  echo "[supervise] exited ($code), restarting in ${delay}s: $1"
  sleep "$delay"
  delay=$(awk -v d="$delay" 'BEGIN { d *= 2; print (d > 60 ? 60 : d) }')
done
