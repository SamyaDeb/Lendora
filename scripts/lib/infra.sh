# shellcheck shell=bash
# Postgres + Redis for scripts/dev.sh (sourced). Sets INFRA (docker|native), DATABASE_URL, REDIS_URL.
# docker-compose when Docker works, else local `postgres` / `redis-server` binaries with data in .dev/
# (STOCKLINE_INFRA=docker|native forces one). Idempotent: already-running infra is reused.
dev_infra() {
  INFRA="${STOCKLINE_INFRA:-}"
  if [ -z "$INFRA" ]; then
    if docker info >/dev/null 2>&1 && docker compose -f "$ROOT/docker-compose.yml" up -d --wait postgres redis >/dev/null 2>&1; then
      INFRA=docker
    else
      INFRA=native
    fi
  elif [ "$INFRA" = docker ]; then
    docker compose -f "$ROOT/docker-compose.yml" up -d --wait postgres redis
  fi
  if [ "$INFRA" = native ]; then
    if [ ! -d "$DEV/pg" ]; then initdb -D "$DEV/pg" -U stockline --auth=trust -E UTF8 --no-instructions >/dev/null; fi
    if ! pg_isready -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1; then
      pg_ctl -D "$DEV/pg" -o "-p $PG_PORT -h 127.0.0.1 -k $DEV" -l "$DEV/logs/postgres.log" start >/dev/null
    fi
    until pg_isready -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1; do sleep 0.2; done
    createdb -h 127.0.0.1 -p "$PG_PORT" -U stockline stockline 2>/dev/null || true
    if ! redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
      redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --save "" --daemonize yes --logfile "$DEV/logs/redis.log" >/dev/null
    fi
  fi
  export DATABASE_URL="postgres://stockline@127.0.0.1:$PG_PORT/stockline"
  export REDIS_URL="redis://127.0.0.1:$REDIS_PORT"
  echo "[dev] infra: $INFRA (postgres :$PG_PORT, redis :$REDIS_PORT)"
}
