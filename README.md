# Stockline

Stock lending layer for Robinhood Chain, built on unmodified Morpho Blue and MetaMorpho.
Start with [`docs/LITEPAPER.md`](docs/LITEPAPER.md) and the PRD in [`docs/prd/`](docs/prd/README.md).

| Path | What | Status |
|---|---|---|
| `contracts/` | Foundry project: wrapper, oracle, `clUSDG`, router, `MarketHours` | Phase 1 in progress |
| `packages/sdk/` | Shared TS: addresses, ABIs, and the math the contracts use (health factor, buffer, oracle price) | Phase 1 |
| `keepers/` | Allocator, guard, fee converter, fallback liquidator, alerts | Phase 1 (tasks 9–11) |
| `indexer/` | Ponder indexer for short interest | Phase 2 |
| `api/` | Public REST + WebSocket API | Phase 2 |
| `web/` | Next.js app | Phase 2 |
| `sim/` | Python parameter simulations | Phase 1 (oracle params) |
| `docs/` | Litepaper, PRD, runbooks | |

## Contracts

```sh
git submodule update --init contracts/lib/forge-std contracts/lib/openzeppelin-contracts \
  contracts/lib/morpho-blue contracts/lib/metamorpho-v1.1
git -C contracts/lib/metamorpho-v1.1 submodule update --init lib/openzeppelin-contracts
cd contracts && forge build && forge test
```

Dependencies (never modified):

| Submodule | Pin |
|---|---|
| `morpho-blue` | `v1.0.0` (the audited, deployed release) |
| `metamorpho-v1.1` | `3b17547` (`main`; the repo has no tags) |
| `openzeppelin-contracts` | `v5.4.0` |
| `forge-std` | `v1.9.7` |

MetaMorpho imports Morpho Blue by relative path into its own nested submodule. `foundry.toml` remaps that path to our
top-level `morpho-blue` (`v1.0.0`) so there is exactly one set of Morpho types. The two copies differ only in comments,
license headers and formatting. MetaMorpho keeps its own nested OpenZeppelin, the version it was audited with.

## SDK

```sh
pnpm install && pnpm test
```
