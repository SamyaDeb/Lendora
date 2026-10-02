#!/usr/bin/env bash
# supervise.sh <cmd...>: run <cmd>, restart it whenever it exits, and redact URL paths from its output.
#
# T16: Ponder exits on an unhandled rejection when every RPC fails (46630, a DNS outage on the host): the indexer
# stayed down and the API fell 50k blocks behind until a manual restart. Ponder resumes from its checkpoint, so a
# restart is always safe. Backoff: SUPERVISE_DELAY_SEC (default 5), doubling up to 60 s, reset after 10 min up.
# T17: Ponder logs the failing RPC URL with its API key; our services redact themselves (OFF-1), Ponder does not.
# The same rule as @lendora/sdk redactSecrets: keep scheme and host, replace userinfo and path.
# T41: a service can also be stuck while running (the indexer drifted 151k blocks behind on a throttled RPC; a restart
# catches up with ranged log queries). SUPERVISE_CHECK (a shell command), when set, runs every SUPERVISE_CHECK_EVERY_SEC
# (default 60); after SUPERVISE_CHECK_FAILS (default 10) failures in a row the service is stopped and restarted.
# Runs inside detached_start's process group, so detached_stop ends the loop and the service together.
set -uo pipefail
[ $# -gt 0 ] || { echo "usage: supervise.sh <cmd...>" >&2; exit 2; }
redact() { perl -pe 'BEGIN { $| = 1 } s#\b((?:https?|wss?)://)(?:[^\s/"@]*@)?([^\s/"?\#]+)[/?\#][^\s"]*#$1$2/[redacted]#g'; }
base="${SUPERVISE_DELAY_SEC:-5}"
delay="$base"
every="${SUPERVISE_CHECK_EVERY_SEC:-60}"
maxfails="${SUPERVISE_CHECK_FAILS:-10}"
while :; do
  started=$(date +%s)
  "$@" > >(redact) 2>&1 &
  pid=$!
  if [ -n "${SUPERVISE_CHECK:-}" ]; then
    fails=0
    while kill -0 "$pid" 2>/dev/null; do
      sleep "$every"
      kill -0 "$pid" 2>/dev/null || break
      if sh -c "$SUPERVISE_CHECK" >/dev/null 2>&1; then fails=0; else fails=$((fails + 1)); fi
      if [ "$fails" -ge "$maxfails" ]; then
        echo "[supervise] health check failed $fails times, restarting: $1"
        kill -TERM "$pid" 2>/dev/null
        for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
        kill -KILL "$pid" 2>/dev/null
        break
      fi
    done
  fi
  wait "$pid"
  code=$?
  [ $(( $(date +%s) - started )) -ge 600 ] && delay="$base"
  echo "[supervise] exited ($code), restarting in ${delay}s: $1"
  sleep "$delay"
  delay=$(awk -v d="$delay" 'BEGIN { d *= 2; print (d > 60 ? 60 : d) }')
done
