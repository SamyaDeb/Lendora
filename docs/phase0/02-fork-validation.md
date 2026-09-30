# Phase 0 · WS-B · Fork validation

Fork tests live in [`contracts/test/fork/phase0/`](../../contracts/test/fork/phase0/). They skip cleanly when
`ROBINHOOD_RPC_URL` is unset (`vm.envOr` + `vm.skip(true)` in `Phase0ForkBase.setUp`), so the default CI job stays
offline. The manual CI job is [`.github/workflows/fork-tests.yml`](../../.github/workflows/fork-tests.yml)
(`workflow_dispatch`, reads the `ROBINHOOD_RPC_URL` repo secret, optional `fork_block` input).

**Recorded run.** Block **73,213,529** (2026-09-26 16:07:17 UTC, a Saturday), public RPC, 16/16 passed.
Full log: [`evidence/fork-run.log`](evidence/fork-run.log). `FORK_BLOCK` in `Phase0ForkBase` is pinned to it.

**Caveat on pinning.** The public RPC is not an archive node and serves state for only the last few thousand blocks
(minutes). The recorded run therefore forked at "latest" (`PHASE0_FORK_BLOCK=0`) and the pinned constant was set to
the block it resolved to. Re-running at the pinned block needs an archive `ROBINHOOD_RPC_URL` (e.g. Alchemy).
`PHASE0_FORK_BLOCK=<n>` overrides the pin; `0` means latest.

```sh
cd contracts
ROBINHOOD_RPC_URL=<archive rpc> forge test --mp "test/fork/**" -vv          # pinned block 73,213,529
ROBINHOOD_RPC_URL=<any rpc> PHASE0_FORK_BLOCK=0 forge test --mp "test/fork/**" -vv   # latest
```

A fork executes Foundry's EVM (revm) against Robinhood Chain state, not Nitro. Behavior that depends on the node itself
(opcode support) was also checked directly on Nitro with `eth_call` (see EVM version below).

## Results

| Test | Question answered | Result | Block |
|---|---|---|---|
| `StockTokenTransfer` · `test_phase0_stockTokens_transferExactToEoaWrapperAndMorpho` | Do SPY, NVDA, AAPL move exactly to an EOA, into a fresh `StockWrapper` (`wrap` reverts unless exactly `rawAmount` arrives) and into Morpho Blue via `supply` (raw and wrapped idle markets), then back out via `withdraw` + `unwrap` to an EOA? (A2, LM-R1, LM-R3, LM-R7) | **PASS** for all three. Exact amounts at every hop with an odd amount (3.1416e18); `wrapper.multiplier() == uiMultiplier()`; LM-R7 equality holds before and after. Balances funded with `deal` (the ERC-7201 namespaced ERC20 slot is found by stdstore; `totalSupply` adjusted; behavior identical to real balances in every assertion) | 73,213,529 |
| `StockTokenAdmin` · `blocklistWrapper` | What happens if the issuer blocklists our wrapper? | **Risk confirmed.** `unwrap` reverts `Blocked(wrapper)`; `approve(wrapper)` reverts, so `wrap` cannot start. Backing stays in the wrapper (not seized). Wrapped units still transfer, and Morpho supply/withdraw of wrapped units keep working. Net: lenders and liquidators keep `wNVDA` but cannot get NVDA out | 73,213,529 |
| `StockTokenAdmin` · `blocklistRecipient` | LM-R6: clear error when the unwrap recipient may not hold the stock? | **PASS.** The token reverts with `Blocked(recipient)`; no adapter needed for a clear error | 73,213,529 |
| `StockTokenAdmin` · `blocklistMorpho_doesNotTouchWrappedMarkets` | Does blocking Morpho Blue hurt Lendora markets? | No: Lendora markets hold wrapper units, so Morpho being blocked on the Stock Token is irrelevant to them. (It would freeze the 19 raw-stock markets.) The wrapper is the single choke point | 73,213,529 |
| `StockTokenAdmin` · `tokenPause` | Per-token pause? | **Risk confirmed.** `unwrap` reverts `IsPaused()`; wrapped units and Morpho keep working | 73,213,529 |
| `StockTokenAdmin` · `globalPause` | Registry-wide pause? | **Risk confirmed.** SPY, NVDA and AAPL all report `paused()`; `unwrap` reverts; `tokenPaused()` stays false (separate flags) | 73,213,529 |
| `StockTokenAdmin` · `adminBurnFromWrapper_breaksLMR7` | Can the issuer burn the wrapper's backing? | **Yes. LM-R7 breaks.** After `adminBurn(wrapper, 3e18)` of 10e18 backing, `balanceOf(wrapper) < totalSupply()`. First unwrappers exit whole; the last 3e18 wrapper units revert (`ERC20InsufficientBalance`). No pause or blocklist check guards `adminBurn` | 73,213,529 |
| `Erc8056` · `readFields` | Live multiplier fields; wrapper passthrough on real tokens (LM-R3) | **PASS.** SPY 1.001717991187472003, NVDA 1.000775159164630595, AAPL 1.000566080061092436; `newUIMultiplier == uiMultiplier` (no pending change); `underlyingEquivalent(1e18) == m`; `balanceOfUI` matches | 73,213,529 |
| `Erc8056` · `scheduledUpdateTakesEffectWithoutPoke` | A1: does `uiMultiplier()` switch at `effectiveAt` with no transaction? | **PASS (A1 holds).** Impersonated MULTIPLIER_UPDATER scheduled +0.3% 1 h ahead; at `effectiveAt − 1` old value, at `effectiveAt` new value, no tx in between; wrapper sees it in the same block | 73,213,529 |
| `Erc8056` · `immediateUpdateIsAStep` | Can the multiplier jump with no notice? | **Yes.** `updateMultiplier(uint256)` applies ×4 immediately | 73,213,529 |
| `MorphoMarket` · `lifecycle_LMR11` | Full lifecycle on the **real Morpho Blue**: loan = wrapped real NVDA, collateral = real USDG, test oracle, AdaptiveCurveIRM, LLTV 77% (LM-R11) | **PASS.** Supply 100 wNVDA → collateral 1.5× → borrow 20 wNVDA → unwrap to real NVDA → 30 days: debt 20 → 20.00991 wNVDA → price +20% → `liquidate` half the shares (repaid 10.005 wNVDA, seized 2,910.06 USDG to the liquidator) → liquidator unwraps leftovers → lender withdraws half the shares for > 50 wNVDA and unwraps. LM-R7 equality holds at the end. Also asserts AdaptiveCurveIRM, 77%, 62.5%, `irm 0`, `lltv 0` are enabled | 73,213,529 |
| `MorphoMarket` · `idleMarketAndMetaMorphoV11` | Idle market (A5) and a MetaMorpho v1.1 vault over the wrapper (A6) | **PASS, with a caveat.** The idle market (`irm 0`, `lltv 0`) is created on the real Morpho. **No MetaMorpho factory exists on Robinhood Chain**, so the test deploys `MetaMorphoV1_1Factory` (our pinned `3b17547`) on the fork: caps, supply queue (stock market first), deposit, `reallocate` 20 to idle, full redeem all work | 73,213,529 |
| `ChainlinkFeeds` · `latestRoundData` | Decimals, description, freshness, pause flag | **PASS.** All 8 decimals; descriptions `RHSPY / USD`, `RHNVDA / USD`, `Robinhood AAPL / USD`, `USDG / USD`. Ages on a Saturday: SPY 24.1 h (86,657 s), NVDA 20.2 h, AAPL 20.3 h (weekend freeze), USDG 29 min. `oraclePaused()` false on all three tokens | 73,213,529 |
| `ChainlinkFeeds` · `noSequencerUptimeFeed` | Is there a sequencer uptime feed? | Not listed by Chainlink; the Arbitrum One uptime feed address has no code here (recorded as NO in WS-A) | 73,213,529 |
| `UsdgPermit` · `decimalsAndPermit` | A7: 6 decimals and EIP-2612 `permit` on real USDG | **PASS (A7 holds).** Signed permit sets the allowance; nonce +1; replay reverts. `permit` is served by facet `0x780d30b6…1309` | 73,213,529 |
| `EvmVersion` · `cancunOpcodes` | A4: a `cancun` build with TSTORE/TLOAD, MCOPY, BLOBBASEFEE deploys and runs | **PASS** on the fork. **Also verified on Nitro directly:** `eth_call` of creation code using TSTORE/TLOAD/MCOPY returns the expected word at ≈ block 73,206,541, identical to Ethereum mainnet; PUSH0 works; 0xEF is rejected as invalid | 73,213,529 (fork); ≈73,206,541 (Nitro) |

## What the admin tests mean

The risk is concentrated in the wrapper. Blocking, pausing or burning *at the wrapper address* freezes or shrinks
the backing of every `wSTOCK` unit at once. Morpho accounting keeps working in wrapper units, so borrowers can still
repay and liquidators can still seize. But nobody can turn `wSTOCK` back into the Stock Token until the issuer
reverses the action, and `adminBurn` is not reversible. Options are in [`04-prd-decisions.md`](04-prd-decisions.md)
(D3, D10).

## Not covered here

- LM-R12 (liquidation with `clUSDG` unwrap in a callback): `clUSDG` does not exist yet (Phase 1 task 6).
- A liquidation that buys wNVDA on a DEX inside the Morpho callback: that needs the router/liquidator (tasks 8, 11).
  WS-C covers the economics.
- A weekday run: the recorded run is on a Saturday. Behavior does not depend on the day, but feed ages do.
