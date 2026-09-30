# shellcheck shell=bash
# Detached services for scripts/dev-testnet.sh (sourced). Needs ROOT, RUN (pid files) and LOGS (log files).
# Each service runs in its own process group (perl setpgrp) and its pid file holds that group's id, so stop reaches
# the service and everything it spawned (tsx → node, next dev → workers), and survives this shell.

detached_alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }

# detached_start <name> <dir> [NAME=value ...] -- <cmd...>: start <cmd> in $ROOT/<dir> with that env, unless running.
detached_start() {
  local n="$1" dir="$2"; shift 2
  local vars=()
  while [ "$1" != -- ]; do vars+=("$1"); shift; done
  shift
  if detached_alive "$n"; then echo "[dev] $n already running (pid $(cat "$RUN/$n.pid"))"; return; fi
  # `export` is a builtin: values (the keeper key) never appear in a process argv. Only `nohup` is backgrounded, so
  # `$!` is the perl process that becomes the group leader (backgrounding the whole `cd && export && nohup` list made
  # `$!` a wrapper subshell, and stop killed that wrapper while the service kept running and holding its port).
  (cd "$ROOT/$dir" && export "${vars[@]}" && {
    nohup perl -e 'setpgrp(0,0); exec @ARGV or die "exec: $!"' "$@" >>"$LOGS/$n.log" 2>&1 &
    echo $! >"$RUN/$n.pid"
  })
  echo "[dev] $n → ${LOGS#"$ROOT"/}/$n.log"
}

# detached_stop <name>: TERM the service's process group, KILL it after 10 s, and clear the pid file.
detached_stop() {
  local n="$1"
  if detached_alive "$n"; then
    local pid; pid="$(cat "$RUN/$n.pid")"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 -- "-$pid" 2>/dev/null || break; sleep 0.2; done
    kill -KILL -- "-$pid" 2>/dev/null || true
    echo "[dev] stopped $n"
  fi
  rm -f "$RUN/$n.pid"
}
