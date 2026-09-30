#!/bin/sh
# Service switch for infra/Dockerfile. Keepers keep their dry-run default unless DRY_RUN=false is set explicitly.
set -e
case "$SERVICE" in
  indexer) exec pnpm --filter @lendora/indexer start ;;
  reconcile) exec pnpm --filter @lendora/indexer reconcile ;;
  api) exec pnpm --filter @lendora/api start ;;
  compliance) exec pnpm --filter @lendora/compliance start ;;
  allocator|guard|liquidator|alerts|feed-mirror|monitor|fee-converter|dn-rebalancer|nav-reporter|venue-mirror) exec pnpm --filter @lendora/keepers "$SERVICE" ;;
  nav-cosigner) NAV_MODE=cosigner exec pnpm --filter @lendora/keepers nav-reporter ;;
  *) echo "set SERVICE to indexer|reconcile|api|compliance|allocator|guard|liquidator|alerts|feed-mirror|monitor|fee-converter|dn-rebalancer|nav-reporter|nav-cosigner|venue-mirror" >&2; exit 1 ;;
esac
