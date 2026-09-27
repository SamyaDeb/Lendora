# Threat model

For each attacker: what they can try, the control that stops or bounds it, and the test that covers it. Paths are
under `contracts/test/` unless noted. Roles and trust assumptions: [README §3](README.md#3-roles-and-trust-assumptions).

## 1. Unattested user (geo-blocked, sanctioned, or just skipping compliance)

| Attempt | Control | Test |
|---|---|---|
| Call `borrow`/`openShort` without a valid attestation, with someone else's, an expired one or one for another chain | EIP-712 attestation bound to user, chain (domain) and expiry (RT-R2); signer `address(0)` blocks all | `router/StocklineRouter.t.sol` `test_RT_R2_attestationBoundToUserChainAndExpiry`; `compliance/test/compliance.test.ts` `RT_R2 …` |
| Mint `clUSDG` through `addCollateral` with no position, then borrow directly on Morpho (the 2026-09-27 finding) | `addCollateral` requires `borrowShares > 0` for `onBehalf` (RT-R8) | `test_RT_R8_unattestedUserCannotCreateCollateral` |
| Obtain `clUSDG` any other way (buy it, receive it) | Transfers only to/from Morpho, the router or mint/burn (CL-R3) | `CollateralToken/CollateralToken.t.sol` CL-R3 tests |
| Borrow directly on Morpho with collateral already there (attested once, repaid-but-not-withdrawn, seized) | Accepted residual (05 §1): bounded by vault caps and allocator pulls; `DIRECT_BORROW` pages (MON-R10) | `test_RT_R8_residualDirectBorrowDocumented`; `keepers/test/monitor.test.ts` `MON_R10` |
| Spoof geo headers to the compliance signer | Geo/IP headers trusted only with the proxy secret; service refuses to start without it off anvil; web proxy drops client geo headers (CP-R8) | `compliance/test/compliance.test.ts` `CP_R8_*`; `web/test/complianceProxy.test.ts` |
| Farm attestations (many IPs or many wallets) | `/attest` rate limit per IP and per wallet; 24h expiry | `CP_R8 /attest is rate-limited per IP and per wallet` |

## 2. Malicious swap target data (or a malicious DEX)

| Attempt | Control | Test |
|---|---|---|
| Point a swap at an arbitrary contract (e.g. Morpho, `clUSDG`, a token to steal approvals) | Allowlisted targets only; never Morpho or `clUSDG` (RT-R3) | `test_RT_R3_onlyAllowlistedTargets`, `test_RT_setSwapTargetRejectsZeroAndClUsdg` |
| Lie in return data (inflated `amountOut`) | Output measured by balance delta; return data never read (RT-R3) | `test_RT_R3_neverTrustsSwapReturnData`; liquidator `test_guardsAndAuth` |
| Partial fill, fee, slippage | User `minOut`/`maxIn`; unsold input refunded | `test_RT_R3_partialFillRefundsStockAndSlippageReverts` |
| Keep a dangling approval | Approval reset to 0 after each swap; router holds nothing (RT-R5) | `invariant_RT_R5_routerHoldsNothing` (1M calls, misbehaving DEX) |
| Revert inside the swap to grief a liquidation | The whole liquidation reverts atomically; nothing half-done | `liquidator/StocklineLiquidator.t.sol` `test_LM_R12_revertingSwapBubblesUpAndUndoesTheLiquidation`, router `test_RT_R3_revertingSwapTargetBubblesItsError` |
| Reenter the router / liquidator during the swap | `nonReentrant` (transient) on every entry; liquidator callback requires `msg.sender == Morpho` and its own in-liquidation flag | Router invariant suite; liquidator auth tests |

## 3. Oracle manipulation via thin pools

| Attempt | Control | Test |
|---|---|---|
| Move the DEX to move `price()` | `price()` uses Chainlink only; the DEX floor is off (D8); the DEX is only a guard input | `oracle/StocklineOracle.t.sol` (price independent of DEX) |
| Move the DEX to trip the guard (grief) | DEVIATION trip only pauses new borrows; clears after 30 min under threshold | `keepers/test/guard.test.ts` deviation tests |
| Push a bad Chainlink round (e.g. 1e18 scaling) | Sanity band ×0.5–×2 and $0.01–$1e6; last good answer kept; guard trips (OR-R7) | `test_phase1_exit_1e18FeedIncident` (fork), oracle vector tests |
| Exploit a stale feed | STALE guard (heartbeat + 10 min in an open session); pages MON-R5 | oracle STALE tests; `MON_R5` |
| Make `price()` step down more than Morpho's bound via buffers, calendar pushes or params | B_MAX ≤ 20%, ramps, multiplier excluded from `price()` (OR-R8) | `testFuzz_OR_R8_*` |
| Borrow against a buffer that is about to ramp in | HF ≥ 1.10 at t + 24h including closure and event buffers (RT-R1) | `test_RT_R1_healthFactorAtTPlus24h`, `test_RT_R1_eventBufferCountsInTheHorizon` |

## 4. Keeper compromise

| Keeper | Worst case | Bound / detection |
|---|---|---|
| Allocator key | Pull all liquidity (borrowing paused) or allocate up to caps | Vault caps and relative cap (U_MAX); cannot move funds out of the vault; MON-R12 utilization, runbook keeper-down |
| Guard keeper key | Trip DEVIATION / L2_GAP (pause new borrows) | Cannot change prices or clear onchain reasons; guardian clears; MON-R7 pages |
| Liquidator bot key | Liquidate at a loss to itself | Liquidations are permissionless anyway; profit checked by `minProfit` |
| Keeper down | No pulls on trip, no liquidations by us | MON-R9 KEEPER_DOWN, MON-R11 PULL_NOT_EFFECTIVE, MON-R2 MISSED_LIQUIDATION (`keepers/test/monitor.test.ts`) |

## 5. Compliance signer compromise

Attacker attests any address. Effect: the soft gate is gone for new entries; RT-R1 (guard, HF, per-address and global
caps) still applies on every router entry, and vault caps bound total exposure. Response: guardian trips, owner rotates
`setAttestationSigner` through the timelock (runbook direct-borrow / README roles). Test: signer rotation and
`address(0)` in `test_RT_R2_attestationBoundToUserChainAndExpiry`.

## 6. Guardian compromise (2 of 4)

Can pause new borrowing (trip, deallocate, lower caps) and raise the buffer floor up to B_MAX (existing positions need
more collateral; OR-R8 bounds the step). Cannot lower the floor, change params, touch the router, move funds or block
exits. Recovery: owner rotates `setGuardian` and the vault sentinel through the timelock. Tests: oracle role tests
(`test/oracle`), vault role wiring (`test/deploy/DeployRoles.t.sol`).

## 7. Owner (timelock) compromise

The strongest role: a malicious router upgrade could abuse router allowances and Morpho authorizations granted by users.
Controls: 4-of-7 multisig on hardware wallets; 48h delay on every action (users can revoke approvals and Morpho
authorization, and exit, in that window; the UI explains revocation, RT-R7); the monitor watches the timelock (planned
Phase 3: page on any `CallScheduled`). Tests: `test_RT_R7_upgradeOnlyByTimelockAndInitializeOnce`,
`test_RT_R7_R8_upgradeFromPhase2ImplementationThroughTimelock`, `packages/devnet/test/runbooks.test.ts` (real timelock
operations).

## 8. Issuer actions (Stock Token)

| Action | Effect | Control / test |
|---|---|---|
| Pause (token or global) | Stock-moving exits revert in the token (A25); guard trips (D4) | `test_phase1_exit_issuerPause` (fork); runbooks test issuer pause |
| Blocklist the wrapper | Unwraps revert; guard WRAPPER_BLOCKED | `test/fork/phase1/BlocklistHolderAllowlist.fork.t.sol`; oracle D4 tests |
| `adminBurn` from the wrapper | wSTOCK under-backed; last unwrappers lose (known issue 4) | `test_LM_R7_R8_adminBurnBreaksBackingAndShowsShortfall`, `test_phase1_exit_adminBurnShowsShortfall` (fork); MON-R3 |
| Multiplier change without a pause window | MULTIPLIER guard latched; owner confirms (OR-R3) | oracle OR-R3 tests; runbooks test multiplier confirm |
| Paxos freeze / wipe (USDG) | Unwrap blocked / `clUSDG` under-backed (known issue 5) | `test/fork/phase1/CollateralTokenFreeze.fork.t.sol`; MON-R4 |
