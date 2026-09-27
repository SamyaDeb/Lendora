# Stockline

Stock lending layer for Robinhood Chain, built on unmodified Morpho Blue and Morpho Vault V2.
Start with [`docs/LITEPAPER.md`](docs/LITEPAPER.md) and the PRD in [`docs/prd/`](docs/prd/README.md).

| Path | What | Status |
|---|---|---|
| `contracts/` | Foundry project: wrapper, oracles, `MarketHours`, `clUSDG`, router, liquidator, deploy scripts (Vault V2) | Phase 1 done (2026-09-27); audit in Phase 3 |
| `packages/sdk/` | Shared TS: addresses, typed ABIs, calendar generator, oracle/buffer/health/allocator math, test vectors | Phase 1 done |
| `keepers/` | Allocator, guard and fallback-liquidator keepers (dry run by default); fee converter and alerts later | Phase 1 done (tasks 9–11) |
| `indexer/` | Ponder indexer for short interest | Phase 2 |
| `api/` | Public REST + WebSocket API | Phase 2 |
| `web/` | Next.js app | Phase 2 |
| `sim/` | Python parameter simulations | Phase 1 (oracle params) |
| `docs/` | Litepaper, PRD, runbooks | |

## Contracts

```sh
git submodule update --init contracts/lib/forge-std contracts/lib/openzeppelin-contracts \
  contracts/lib/morpho-blue contracts/lib/metamorpho-v1.1 contracts/lib/vault-v2
git -C contracts/lib/metamorpho-v1.1 submodule update --init lib/openzeppelin-contracts lib/morpho-blue
git -C contracts/lib/vault-v2 submodule update --init lib/morpho-blue lib/morpho-blue-irm
git -C contracts/lib/vault-v2/lib/morpho-blue-irm submodule update --init lib/morpho-blue
cd contracts && forge build && forge test
```

Dependencies (never modified):

| Submodule | Pin |
|---|---|
| `morpho-blue` | `v1.0.0` (the audited, deployed release) |
| `vault-v2` | tag `2025-12-04` (`425f6b1`): sources match the onchain `VaultV2Factory` and `MorphoMarketV1AdapterV2Factory` (Sourcify); runtime code verified by `test/fork/phase1/VaultV2CodeHash.fork.t.sol` |
| `metamorpho-v1.1` | `3b17547` (`main`; no tags). Superseded by Vault V2 (D6); kept only for the scaffold smoke test and the Phase 0 fork record |
| `openzeppelin-contracts` | `v5.4.0` |
| `forge-std` | `v1.9.7` |

MetaMorpho imports Morpho Blue by relative path into its own nested submodule. `foundry.toml` remaps that path to our
top-level `morpho-blue` (`v1.0.0`) so there is exactly one set of Morpho types (the nested copy is checked out only
so forge's linter can resolve paths; solc never compiles it). The two copies differ only in comments,
license headers and formatting. MetaMorpho keeps its own nested OpenZeppelin, the version it was audited with.

Vault V2 is compiled with Morpho's own settings (solc 0.8.28, via-IR, 100k runs, cancun) through a
`compilation_restrictions` profile in `foundry.toml`, and keeps its own nested `morpho-blue` and `morpho-blue-irm`, so the
bytecode equals the deployed one. Stockline code talks to it only through `src/interfaces/external/IMorphoVaultV2.sol`.

## Keepers

```sh
pnpm --filter @stockline/keepers test        # needs anvil (Foundry) on PATH
DEPLOYMENT_KEY=fork-4663 RPC_URL=<rpc> pnpm --filter @stockline/keepers allocator   # dry run
```

## SDK

```sh
pnpm install && pnpm test
```
