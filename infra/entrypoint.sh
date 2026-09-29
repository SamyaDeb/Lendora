#!/bin/sh
# Service switch for infra/Dockerfile. Keepers keep their dry-run default unless DRY_RUN=false is set explicitly.
set -e
case "$SERVICE" in
  indexer) exec pnpm --filter @stockline/indexer start ;;
  reconcile) exec pnpm --filter @stockline/indexer reconcile ;;
  api) exec pnpm --filter @stockline/api start ;;
  compliance) exec pnpm --filter @stockline/compliance start ;;
  allocator|guard|liquidator|alerts|feed-mirror|monitor|fee-converter|dn-rebalancer|nav-reporter) exec pnpm --filter @stockline/keepers "$SERVICE" ;;
  nav-cosigner) NAV_MODE=cosigner exec pnpm --filter @stockline/keepers nav-reporter ;;
  *) echo "set SERVICE to indexer|reconcile|api|compliance|allocator|guard|liquidator|alerts|feed-mirror|monitor|fee-converter|dn-rebalancer|nav-reporter|nav-cosigner" >&2; exit 1 ;;
esac
