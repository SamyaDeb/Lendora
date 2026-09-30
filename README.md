# Lendora

Stock lending layer for Robinhood Chain, built on unmodified Morpho Blue and Morpho Vault V2.
Start with [`docs/LITEPAPER.md`](docs/LITEPAPER.md) and the PRD in [`docs/prd/`](docs/prd/README.md).

| Path | What | Status |
|---|---|---|
| `contracts/` | Foundry project: wrapper, oracles, `MarketHours`, `clUSDG`, router, liquidator, deploy scripts (Vault V2) | Phase 1 done; remediation done (2026-09-28, RT-R8); Phase 3: `FeeSplitter`, `FeeConverter`, `DeployMainnet` + `VerifyRoles` (never broadcast); audit round 1 + round 2 scope ready ([`docs/audit`](docs/audit/README.md)); Phase 4: delta-neutral vault, strategy, NAV oracle (caps 0), G5 receipt market, `DeployMainnetDryRun`; Phase 4 audit package ([`docs/audit/phase4`](docs/audit/phase4/README.md)) |
| `packages/sdk/` | Shared TS: addresses, typed ABIs, calendar generator, oracle/buffer/health/allocator math, test vectors, timelock calldata tool | Phase 1 done; timelock tool (remediation); vault fee timelock ops, `redactSecrets` (Phase 3); MN-R6 `resolveDeployment`, DN vault ABIs/typed data, DN timelock actions (Phase 4) |
| `keepers/` | Allocator, guard, fallback-liquidator, fee converter (FE-R4), alerts (APP-R8), testnet feed-mirror keepers (dry run by default) and the read-only ops monitor (MON-R1…R20) | Phase 1 done; alerts and feed mirror Phase 2; monitor (remediation); fee converter, MON-R16…R20, offchain security pass (Phase 3); DN rebalancer, NAV reporter + co-signer, MON-R21…R25, OFF-18…21 (Phase 4) |
| `indexer/` | Ponder indexer for short interest (SI-R1…R5) and fee revenue (FE-R5) | Phase 2 done (2026-09-27); revenue (Phase 3); USDG Earn and receipt markets (Phase 4) |
| `api/` | Public REST + WebSocket API, OpenAPI 3.1 (SI-R10…R14) | Phase 2 done; protocol revenue FE-R5, security fixes OFF-7…11 (Phase 3); `/v1/vault/*`, `/v1/receipt-markets` (Phase 4) |
| `compliance/` | Compliance signer, geo/sanctions/terms checks (CP-R1…R4, CP-R8 proxy secret) | Phase 2 done; CP-R8 (remediation); Chainalysis + TRM adapters (Phase 3), provider contract pending (Q5) |
| `web/` | Next.js app (06) and short-interest dashboard (07 §4) | Phase 2 done; Lendora redesign; CSP/HSTS, revenue panel (Phase 3); USDG Earn on the real vault, receipt market (flag), `testnetSmoke` (Phase 4) |
| `packages/devnet/` | Local chain, chain driver, seed week, smoke flows, runbook drills (anvil and 46630 fork) | Phase 2; fork drills (Phase 3); DN driver, Phase 4 fork drills, `live-drills` runner (Phase 4) |
| `infra/` | Dockerfiles (digest-pinned), Railway config (incl. monitor, fee converter, DN rebalancer, NAV reporter/co-signer), health checks, `mainnet.env.example` (launcher template) | Not deployed; mainnet hosting pending (Q15) |
| `packages/launch/` | The one mainnet launch path (`scripts/mainnet-launch.sh`): gates, env/Safe checks, fork rehearsal, typed-confirmation broadcast, VerifyRoles, publish, services | Phase 4 Part D: built, dry-run rehearsed on a local 4663 fork, never run |
| `sim/` | Python parameter simulations: Phase 0 weekend gaps, mainnet parameters (04 §5), event-timing study (Q2) | Phase 3 task 8 done; risk sign-off pending; Phase 4 DN vault sim (`sim/dn_vault`): INSUFFICIENT DATA |
| `docs/` | Litepaper, PRD, runbooks (P0/P1 + mainnet launch), audit package, bug bounty, owner action pack | Phase 3 engineering done 2026-09-28; Phase 4 engineering done 2026-09-29, testnet rehearsed on fork only, mainnet launcher built and never run ([11 Phase 4 status](docs/prd/11-milestones.md#phase-4-status-engineering-2026-09-29)) |

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
bytecode equals the deployed one. Lendora code talks to it only through `src/interfaces/external/IMorphoVaultV2.sol`.

## Local stack (Phase 2)

```sh
scripts/dev.sh --seed      # Postgres + Redis, anvil + DeployLocal, compliance signer, indexer, API, web, keepers
docker compose up -d       # infra only (Postgres, Redis, anvil with the DeployLocal state)
```

Testnet: `docs/runbooks/testnet.md` (deployment waits for the owner's go).

## Keepers

```sh
pnpm --filter @lendora/keepers test        # needs anvil (Foundry) on PATH
DEPLOYMENT_KEY=fork-4663 RPC_URL=<rpc> pnpm --filter @lendora/keepers allocator   # dry run
```

## SDK

```sh
pnpm install && pnpm test
```
