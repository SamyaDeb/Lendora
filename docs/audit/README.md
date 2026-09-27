# Stockline · audit package (Phase 3)

Everything an auditor needs to start: scope, architecture, roles and trust, integrations, invariants with their tests,
how to build and run every suite, and the known issues we accept. Threat model: [threat-model.md](threat-model.md).
Requirements: [`docs/prd`](../prd/README.md) (IDs such as `RT-R8` are referenced in code comments and test names).

*Prepared 2026-09-28 (remediation task 8). Working name "Stockline" (brand decision Q6 pending; nothing renamed).*

## 1. Scope

**Freeze.** Audit round 1 covers the tree at the commit recorded in [`FREEZE`](FREEZE) (the commit that added this
package). Any fix during the audit lands as a new commit referenced in the finding; the diff from the freeze is the
re-review scope. Tag it with `git tag audit-r1-freeze $(cat docs/audit/FREEZE)` when the owner confirms the freeze.

Solidity 0.8.26, `evm_version = cancun`, optimizer 200 runs, `bytecode_hash = none` (`contracts/foundry.toml`).
nSLOC = non-blank, non-comment lines.

| File | nSLOC | What it is | Upgradeable |
|---|---:|---|---|
| `src/StocklineRouter.sol` | 375 | One-transaction user flows; RT-R1 guard/HF/caps, RT-R2 attestation, RT-R8 rescue-only `addCollateral`. UUPS proxy, ERC-7201 storage | Yes (UUPS, owner = 48h timelock) |
| `src/oracles/StocklineOracleBase.sol` | 351 | Morpho `IOracle` core: Chainlink feed + closure/event buffer + guards (OR-R1…R8, R20…R23, R30…R33) | No |
| `src/oracles/StocklineOracle.sol` | 28 | Stock-loan market oracle (wSTOCK loan, clUSDG collateral) | No |
| `src/oracles/ReceiptCollateralOracle.sol` | 33 | `rSTOCK`-collateral / USDG-loan oracle (G5, listed later, CL-R10) | No |
| `src/MarketHours.sol` | 127 | Feed sessions and event windows (OR-R10…R14) | No (owner-set schedule) |
| `src/StockWrapper.sol` | 66 | Non-rebasing 1:1 wrapper of an ERC-8056 Stock Token (LM-R1…R8) | No |
| `src/CollateralToken.sol` | 71 | `clUSDG`: gated 1:1 USDG wrapper, router-only mint (CL-R1…R7) | No |
| `src/StocklineLiquidator.sol` | 115 | Fallback liquidator: Morpho callback unwraps `clUSDG`, swaps, wraps, repays (LM-R12) | No (redeployable) |
| `src/ShortInterestLens.sol` | 65 | View-only aggregation (SI-R20, R21) | No (redeployable) |
| `src/adapters/BlocklistHolderAllowlist.sol` | 14 | Optional unwrap pre-check against the issuer blocklist (LM-R6) | No |
| `src/libraries/OracleMath.sol` | 54 | Buffer and health-factor math shared by oracles and router | – |
| `src/libraries/VaultV2Ids.sol` | 16 | Vault V2 cap ids | – |
| `src/interfaces/*.sol` | 231 | Stockline interfaces (`IStocklineRouter`, `IStocklineOracle`, `IMarketHours`, `IStockWrapper`, `ICollateralToken`, `IShortInterestLens`, `IHolderAllowlist`) | – |
| `src/interfaces/external/*.sol` | 122 | Minimal copies of third-party interfaces (Vault V2, Chainlink, Robinhood Stock Token, ERC-8056) | – |
| **Total** | **1,668** | | |

Also in scope, **deployment logic only**: `script/StocklineDeploy.sol` (wiring, roles, caps, timelocks — LM-R10,
LM-R20…R23) and `script/DeployTestnet.s.sol` role defaults (A27 must not carry to mainnet).

**Out of scope.** Morpho Blue (`lib/morpho-blue` v1.0.0, deployed at `0x9D53…1010`), Morpho Vault V2 and
`MorphoMarketV1AdapterV2` (`lib/vault-v2` @ `425f6b1`, used unmodified from the official factories; runtime-code
equality is fork-tested: `test/fork/phase1/VaultV2CodeHash.fork.t.sol`), OpenZeppelin (`lib/openzeppelin-contracts`),
forge-std, MetaMorpho v1.1 (`lib/metamorpho-v1.1`, kept only for the scaffold smoke test; removal pending the owner's
call), everything under `test/` (mocks included) and `script/` except the files named above, and all offchain code
(keepers, indexer, API, web, compliance) — those have their own review item in the Phase 3 plan.

**Size note.** `StocklineRouter` runtime is 24,092 bytes: 484 bytes under EIP-170. Any fix that grows it must be
checked with `forge build --sizes`.

## 2. Architecture

```
                        ┌──────────────────────── Web app (Next.js) ───────────────────────┐
                        │  Lend · Borrow/Short · Positions · Short-interest dashboard       │
                        └──────────────┬───────────────────────────────┬───────────────────┘
                                       │ tx (viem/wagmi)               │ REST / WS
                                       ▼                               ▼
┌────────────────── Stockline contracts ──────────────────┐   ┌──── Offchain ─────────────────┐
│ StocklineRouter (UUPS; borrow/openShort attested)        │   │ Indexer (Ponder) → Postgres   │
│ StockWrapper  wNVDA  (non-rebasing wrapper of NVDA)       │   │ Public API · Compliance signer│
│ CollateralToken clUSDG (gated USDG wrapper)               │   │ Keepers: allocator, guard,    │
│ StocklineOracle (per market; closure/event buffer, guards)│   │   liquidator, alerts, monitor │
│ MarketHours (feed sessions + event windows)               │   └───────────────────────────────┘
│ StocklineLiquidator · ShortInterestLens                   │
│ TimelockController (owner of the above and the vaults)    │
└─────────────┬───────────────────────────────┬────────────┘
              ▼                               ▼
   Vault V2 rNVDA ──MarketV1AdapterV2──►  Morpho Blue market
   (caps, idle reserve = unallocated,     loan = wNVDA, collateral = clUSDG,
    perf fee → FeeSplitter)               oracle = StocklineOracle, IRM = AdaptiveCurve, LLTV 77%
                                                    ▲
                                   Chainlink feeds ─┘ (NVDA/USD, USDG/USD)
```

Per stock: one `StockWrapper`, one `StocklineOracle`, one Vault V2 with one adapter, one Morpho market. "Pause new
borrowing" is done by **liquidity** (the allocator deallocates free market liquidity on a guard trip, LM-R31), because
Morpho Blue has no pause; see [02](../prd/02-architecture.md), [03 §4](../prd/03-lending-markets.md), [05](../prd/05-collateral-router.md).

## 3. Roles and trust assumptions

| Actor | Powers | Trust assumption | If compromised |
|---|---|---|---|
| Owner: 4-of-7 multisig → `TimelockController` (48h) | Router upgrade, `listMarket`/`delistMarket`, caps, attestation signer, swap targets; oracle params, `resetReferences`, `clearMultiplierGuard`, floor lowering, sequencer feed; `MarketHours` schedule; Vault V2 owner/curator (curator actions timelocked 48h in the vault) | Honest majority; 48h lets users exit before a malicious change | Malicious router upgrade could steal allowances/authorizations granted to the router (RT-R7). Users can revoke Morpho authorization and approvals during the 48h |
| Guardian: 2-of-4 multisig (= Vault V2 sentinel) | `trip`/`clear` MANUAL, DEVIATION, L2_GAP; `raiseBufferFloor` (≤ B_MAX); vault `deallocate`, cap decreases, `revoke` | Can only reduce risk | Griefing: pause new borrows, raise buffers (existing positions need more collateral; bounded by B_MAX 20% and OR-R8's instant-drop property) |
| Allocator: keeper EOA + multisig | Vault V2 `allocate` / `deallocate`, `setMaxRate` | Liveness | Can move liquidity only between idle and the listed market within caps; can pause borrowing by pulling |
| Guard keeper: EOA | `trip`/`clear` DEVIATION, L2_GAP; `poke` | Liveness | Can pause new borrowing; cannot change prices |
| Compliance signer (EIP-712 key, KMS) | Attestations for `borrow`/`openShort` (RT-R2) | Screens geo, sanctions, terms (CP-R1…R3, CP-R8) | Attests anyone: the soft gate falls back to caps and liquidity limits; rotate via timelock (`setAttestationSigner`) |
| Stock Token issuer | Blocklist, per-token/global pause, `adminBurn`, multiplier, `oraclePaused` | Trusted by users of Stock Tokens | Pause/blocklist: guard trips, exits that move the stock wait (A25). `adminBurn` of the wrapper: unbacked wSTOCK (LM-R8, known issue) |
| Paxos (USDG) | Freeze / wipe any address | Trusted by USDG users | Freeze of `clUSDG`: no unwraps; wipe: under-backed clUSDG (CL-R5, CL-R6, known issue) |
| Chainlink | Stock Token and USDG/USD feeds | Correct within the sanity band | Bad rounds rejected (OR-R7), last good answer kept, guard trips; stale feed trips the guard |
| Morpho Blue / Vault V2 | Lending engine, vault accounting | Audited, deployed, unmodified | Out of scope |

## 4. External integrations

| Integration | Where | Notes |
|---|---|---|
| Morpho Blue v1.0.0 | router, liquidator, oracles (IOracle), lens | `setAuthorization` to the router; liquidation callback in the liquidator |
| Vault V2 + MarketV1AdapterV2 (official factories) | router (`deposit`, `redeem`, `forceDeallocate`), deploy script | No liquidity adapter; `forceDeallocatePenalty = 0` (A12) |
| Chainlink Stock Token feeds (8 dp, 24/5) and USDG/USD | oracles | Feed includes the ERC-8056 multiplier (D1); launch-week 1e18-scaled answers seen (OR-R7) |
| Robinhood Stock Tokens (ERC-8056, issuer registry) | wrapper, oracle guard (D4), blocklist adapter | 18 dp, non-rebasing, exact transfers (A2, fork-verified) |
| USDG (Paxos, 6 dp, EIP-2612) | `clUSDG` backing, router | Freeze/wipe powers (CL-R5) |
| Uniswap UniversalRouter (`0x8876…0904`) | router and liquidator swaps, `SwapMode.Transfer` | Only allowlisted target at launch (Q4); calldata layout A15; return data never trusted (RT-R3) |

## 5. Invariants and properties (with tests)

| ID | Property | Tests |
|---|---|---|
| CL-R6 | USDG held by `clUSDG` ≥ `clUSDG.totalSupply` (absent a Paxos freeze/wipe) | `test/CollateralToken/CollateralToken.invariant.t.sol` `invariant_CL_R6_fullyBacked`, `invariant_CL_R6_exactBacking`; `test/router/StocklineRouter.invariant.t.sol` `invariant_CL_R6_clUsdgFullyBacked` (every router flow, misbehaving DEX, 1M calls at `FOUNDRY_PROFILE=deep`) |
| LM-R7 | Stock Tokens held by the wrapper ≥ wSTOCK supply (absent `adminBurn`) | `test/StockWrapper/StockWrapper.invariant.t.sol` `invariant_LM_R7_*`, `invariant_LM_R8_noShortfallWithoutAdminBurn`; router invariant `invariant_LM_R7_wrapperFullyBacked` |
| RT-R5 | The router holds no tokens and no dangling approvals after any call | `invariant_RT_R5_routerHoldsNothing` (router invariant suite) |
| OR-R8 | Nothing Stockline controls moves `price()` down by more than Morpho's instant-drop bound (17.29% at LLTV 77%) in one block | `test/oracle/StocklineOracle.t.sol` `testFuzz_OR_R8_anyBufferStepWithinMorphoBound`, `testFuzz_OR_R8_liveTransitionsWithinMorphoBound`, `test_OR_R5_R8_paramValidation` |
| RT-R8 | Collateral enters only with a debt position; the rescue top-up is never blocked | `test/router/StocklineRouter.t.sol` `test_RT_R8_*` (4); upgrade from the Phase 2 implementation: `test/router/StocklineRouterUpgrade.t.sol` |
| OR-R2 | `price()` never reverts on feed or guard conditions | `test/oracle/StocklineOracle.t.sol` (reverting/zero/negative feeds), `test/fork/phase1/Lifecycle.fork.t.sol` 1e18 incident |
| LM-R1 | Wrap/unwrap round trip is lossless | `testFuzz_LM_R1_roundTripIsLossless` |
| SI-R20 | Lens: borrowed ≤ supplied, utilization ≤ 1 | `testFuzz_SI_R20_borrowedNeverExceedsSuppliedAndUtilizationBounded` |

SDK math equals the contracts exactly on 36k shared vectors (`test/oracle/OracleVectors.t.sol`,
`test/sdk/MorphoMathVectors.t.sol`).

## 6. Build and run

```sh
# submodules, including the nested ones Vault V2 and MetaMorpho need: see the root README, "Contracts"
cd contracts
forge build --sizes
forge fmt --check
forge test                                               # 205 tests, fork suites skip without an RPC
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-path "test/fork/phase[12]/*"   # latest block (A17)
FOUNDRY_PROFILE=deep forge test --match-contract StocklineRouterInvariantTest   # 3 x 1,000,000 calls
forge coverage --report summary                          # every src/ file ≥ 97.8% lines (2026-09-28)
slither .                                                # config: slither.config.json (triage notes inside); no medium+
forge doc                                                # NatSpec site → docs/audit/forge-doc (not committed)
```

`test/fork/phase0` is pinned to historical blocks and needs an archive RPC (Q7, pending). Offchain:
`pnpm install && pnpm -r typecheck && pnpm -r lint && pnpm -r test` (needs `anvil`, `postgres`/`initdb` on PATH);
`pnpm --filter @stockline/web e2e` (Playwright on the full local stack).

## 7. Known issues and accepted risks

1. **Soft-gate residual (05 §1, RT-R8).** Morpho Blue is permissionless: (a) a borrower attested once can top up via the
   rescue path and borrow more directly on Morpho, beyond the per-address cap; (b) anyone with `clUSDG` in Morpho and
   zero debt can borrow again without a fresh attestation; (c) a liquidator holding seized `clUSDG` can supply it and
   borrow. Bounded by vault caps, idle reserve and allocator pulls; detected by `DIRECT_BORROW` (MON-R10). Before the
   remediation, `addCollateral` had no debt requirement (review finding 2026-09-27, fixed; regression test above).
2. **A12: `forceDeallocatePenalty = 0`.** Anyone can force free market liquidity back to idle for a withdrawal; misuse
   only pauses new borrows until the allocator re-allocates.
3. **A13: re-anchor after a > 2× move.** A genuine move beyond the ×0.5–×2 band between pokes is rejected until the
   owner calls `resetReferences` through the 48h timelock; new borrows stay blocked meanwhile, liquidations use the
   last good price.
4. **Issuer `adminBurn`** of the wrapper's Stock Tokens makes wSTOCK under-backed; cannot be prevented; `backingShortfall()`
   and MON-R3 page; the last unwrappers lose.
5. **Paxos freeze / wipe** of USDG at `clUSDG` blocks unwraps or under-backs `clUSDG` (CL-R5); fork-tested and disclosed.
6. **No sequencer uptime feed on 4663.** `sequencerFeed = address(0)`; the guard keeper's L2 block-gap trip is the
   mitigation (OR-R6). Liquidations right after an outage cannot be delayed.
7. **OR-R14 event timing.** The event buffer is released on the first round at/after `endTs`; a wrong `endTs` (early or
   late) lets an earnings jump through unbuffered. Anchored alternative under study (`sim/event_timing`, Q2).
8. **Per-address cap is soft.** Enforced on router entries only (and valued at the feed price, A11); direct Morpho
   borrows bypass it (item 1).
9. **Router refund branch.** `repay`'s refund of `pull − repaidAssets` is unreachable with Morpho's identical rounding;
   kept as a defensive refund (coverage note).
10. **Issuer pause blocks stock-moving exits** (A25): `repay`, `closeShort`, `withdrawLend`, `unwrap` revert in the token
    while it is paused; USDG-side exits keep working.
