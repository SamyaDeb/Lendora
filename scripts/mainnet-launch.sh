#!/usr/bin/env bash
# The only supported mainnet launch path (docs/runbooks/mainnet-launch.md §3, Phase 4 Part D).
# Refuses unless every gate in docs/owner-actions/launch-gates.json is signed, the tree is a clean tagged release,
# the env has every role (Safes checked onchain), a hardware-wallet/KMS signer, and I_HAVE_THE_OWNERS_GO=1 set by the
# operator; broadcasts only after a typed confirmation. Resumable: re-run after any stop.
#
#   scripts/mainnet-launch.sh --dry-run --skip-suite      # rehearsal against a LOCAL anvil fork of 4663
#   scripts/mainnet-launch.sh [--apply] [--services-env infra/mainnet.env]   # the real launch (owner only)
set -euo pipefail
cd "$(dirname "$0")/.."
exec pnpm --silent --filter @stockline/launch exec tsx src/cli.ts "$@"
