# 05 · Collateral and router

**Phase 1.** Borrowers post `clUSDG`, a gated wrapper around USDG or a yield-bearing USDG vault share. It is minted only
through the router, and that gives Stockline one place to enforce caps, geo-rules and the guard. `StocklineRouter` bundles
every user flow into one transaction.

## 1. Why gated collateral

Morpho Blue markets are permissionless. Anyone holding the collateral token can borrow directly. If collateral were plain
USDG, Stockline could not enforce per-user limits or pause new positions. With `clUSDG`:

- New collateral enters only through the router's attested entries (`borrow`, `openShort`), which check guard state,
  caps and attestation. The only other mint path, `addCollateral`, is a rescue top-up for a position that already has
  debt (RT-R8).
- Exit is always permissionless: anyone holding `clUSDG` can unwrap to the backing asset, so liquidators are never blocked.

**This is a soft gate, and the residual cannot be closed onchain** because Morpho Blue borrowing is permissionless
(anyone with collateral in the market can call `Morpho.borrow` directly):

- (a) A borrower who was attested once can top up through the rescue path and then borrow more directly on Morpho,
  beyond the router's per-address cap and without a fresh attestation.
- (b) Anyone holding `clUSDG` in Morpho with zero debt (for example after `repay` without withdrawing collateral) can
  borrow again directly on Morpho without a fresh attestation.
- (c) A liquidator that seized `clUSDG` may supply it to Morpho (a transfer to Morpho is allowed, CL-R3) and borrow
  against it without an attestation.
- (d) *(found on 46630, 2026-09-30)* An attested borrower may withdraw `clUSDG` collateral from Morpho directly and
  supply it for **any** address (`supplyCollateral(onBehalf)`), which then borrows directly on Morpho without ever
  signing the terms or being attested (for example a restricted-region or sanctioned address). Proven end to end by
  `web/scripts/testnetBreak.ts` (X group); the monitor paged `DIRECT_BORROW` for the new address.
- (e) *(found on 46630, 2026-09-30)* `withdrawCollateral` is an exit, so it has no RT-R1 check: a borrower with debt can
  withdraw down to Morpho's LLTV at today's price, below the 24h weekend/earnings buffer (HF at t+24h < 1.1). Morpho
  allows the same directly, so a router check alone would not close it. The web app only offers "Withdraw collateral"
  when the debt is 0. No alert fires until the position is liquidatable (MISSED_LIQUIDATION covers a failure to act).

The hard limits are the vault caps, the idle reserve and the allocator's liquidity pulls ([03 §4](03-lending-markets.md)):
no path can borrow more than the liquidity the allocator has placed in the market. Mitigation is detection (the
`DIRECT_BORROW` alert, MON-R10 in [10](10-risk-compliance.md)) plus the per-address cap on every router entry. Before the
remediation of 2026-09-27, `addCollateral` needed no debt, so a never-attested address could mint `clUSDG` without any
cap and borrow directly (review finding, fixed by RT-R8; regression test
[`test_RT_R8_unattestedUserCannotCreateCollateral`](../../contracts/test/router/StocklineRouter.t.sol)).

## 2. CollateralToken (`clUSDG`)

| ID | Requirement |
|---|---|
| CL-R1 | `clUSDG` wraps exactly one backing asset, set at deployment: USDG (v1) or a USDG ERC-4626 vault share (v1.1, the "collateral that earns" path). One `clUSDG` = one backing unit. |
| CL-R2 | `mint` is callable only by the router. `unwrap(amount, to)` is callable by any holder and returns the backing asset 1:1. |
| CL-R3 | Transfers are allowed only when `from` or `to` is Morpho Blue, the router or the zero address (mint/burn). Everyone else can only hold and unwrap. This stops secondary trading that would bypass the router. |
| CL-R4 | `valuePerToken()` returns USD value per token in 1e18: 1.0 for USDG; `vault.convertToAssets(1e18)` for vault shares. The oracle reads it (see [04](04-oracle.md)). |
| CL-R5 | No pause on `unwrap` and no admin that can seize or freeze balances. The router address is set once at deployment and cannot change. Stockline cannot stop Paxos from freezing or wiping the `clUSDG` address (or Morpho's) on USDG itself (verified Phase 0, [01 §5](../phase0/01-chain-facts.md#5-usdg)); a fork test documents the effect. |
| CL-R6 | Invariant: backing balance of `clUSDG` ≥ `totalSupply` (in backing units), absent an issuer freeze or wipe of the backing. |
| CL-R7 | A different backing (e.g. an ERC-4626 USDG Vault V2 share, v1.1) is a **new deployment** of a `CollateralToken` variant with its own oracle and Morpho market, never an upgrade of v1. |

**Yield on collateral (short rebate).** With a vault-share backing, the share price rises while it sits in Morpho as
collateral, so the borrower's health improves over time and they keep the yield on unwrap. USDG yield options on Robinhood Chain (verified Phase 0, 2026-09-26): Maple
`syrupUSDG` (`0x40858070814a57FdF33a613ae84fE0a8b4a874f7`, not ERC-4626 on this chain; priced by the Chainlink
`syrupUSDG / USDG Exchange Rate` feed) and 54 Morpho Vault V2 USDG vaults (ERC-4626; largest "Steakhouse USDG"
`0xBeEff033F34C046626B8D0A041844C5d1A5409dd`, ~512M USDG). USDG itself pays opt-in rewards without changing
balances. Vault V2 share prices fall when an underlying market realizes bad debt; [VERIFY] whether the syrupUSDG
rate can ever fall. If it can, the oracle must use a
manipulation-resistant rate and the LLTV must be lower.

## 3. Receipt as collateral (G5, `rSTOCK` → USDG)

Lenders can post `rNVDA` to borrow USDG. This uses a second Morpho market per stock:

| Param | Value |
|---|---|
| loanToken | USDG |
| collateralToken | `rNVDA` (Vault V2 share, not gated) |
| oracle | `ReceiptCollateralOracle(NVDA)`: `convertToAssets` × feed price (never × multiplier, D1) with collateral haircut `(1 − b(t))` |
| LLTV | 62.5% at launch |
| USDG supply | Stockline-curated Vault V2 USDG vault, or an existing USDG Vault V2 (54 exist on this chain) that opts in [VERIFY] |

| ID | Requirement |
|---|---|
| CL-R10 | The market is listed only after the stock-loan market has run 30 days on mainnet without a guard incident. |
| CL-R11 | Seized `rNVDA` can be redeemed by liquidators for `wNVDA` up to vault liquidity. The sim must show liquidations stay profitable when the NVDA vault is at `U_MAX`. |
| CL-R12 | The app shows the recursion risk: `rNVDA` value falls if NVDA falls *and* if the lending vault can't return liquidity. |

**Build status (Phase 4 session, A3):** stage 1 (`script/ListReceiptMarket.s.sol`: oracle, market, USDG Vault V2 with
caps 0, no role kept) and the timelocked listing (SDK `receipt.list`, six curator actions) are built and tested on
anvil and a 4663 fork; CL-R10 is enforced by the script and the SDK on 4663; CL-R11 liquidation and redeem tested.
Runbook: [`list-receipt-market.md`](../runbooks/list-receipt-market.md). Indexer/API/web support behind
`NEXT_PUBLIC_FEATURE_RECEIPT_MARKET`: see the Phase 4 status table in [11](11-milestones.md).

## 4. StocklineRouter

The router is stateless between transactions (it holds configuration, never user balances). Users grant it Morpho
authorization (`setAuthorization`) once and approve tokens via EIP-2612 `permit`, batched with the flow through the
router's `multicall` (USDG, Stock Tokens and `rSTOCK` all support EIP-2612; verified Phase 0 for USDG and Stock Tokens).

| Flow | Steps (all in one tx) | Story |
|---|---|---|
| `lend(stock, amount)` | pull Stock Token → wrap → Vault V2 `deposit` into `rSTOCK` → shares to user | US-L1 |
| `withdrawLend(stock, shares)` | `forceDeallocate` free market liquidity if idle is short (LM-R22) → Vault V2 `redeem` → unwrap → Stock Token to user | US-L3 |
| `borrow(stock, collateralIn, borrowAmt)` | pull USDG → mint `clUSDG` → `supplyCollateral` onBehalf user → `borrow` onBehalf user → unwrap → Stock Token to user | US-B1 |
| `openShort(stock, collateralIn, borrowAmt, minUsdgOut, swapData)` | as `borrow`, then swap Stock Token → USDG via an allowlisted target (Uniswap UniversalRouter first, A8); USDG to user (or add to collateral if `compound=true`) | US-B2 |
| `closeShort(stock, maxUsdgIn, swapData)` | pull USDG → swap to Stock Token → wrap → `repay` all shares → `withdrawCollateral` → unwrap `clUSDG` → USDG to user | US-B4 |
| `addCollateral` | rescue top-up for a position with debt (RT-R8) | US-B5 |
| `repay`, `withdrawCollateral` | single-step helpers | US-B5 |

| ID | Requirement |
|---|---|
| RT-R1 | *(restated D5, D8)* `borrow` and `openShort` revert if the oracle guard is tripped, if the user's resulting health factor at `t + 24h` (including the upcoming closure **and event** buffers, assuming no fresh round) is below `HF_MIN_OPEN = 1.10`, if the user's debt in that market would exceed the per-address cap (D8: SPY $75k, NVDA $250k, AAPL $35k, valued at the feed price; larger limits by owner allowlist for known market makers), or if the global `clUSDG` cap would be exceeded. |
| RT-R2 | `borrow` and `openShort` require a valid attestation (EIP-712 signature from the compliance signer, bound to user, chain and expiry). Other flows (repay, close, withdraw) never require one. See [10](10-risk-compliance.md). |
| RT-R3 | Swaps go only through allowlisted targets with user-set slippage (`minOut`/`maxIn`), starting with Uniswap's UniversalRouter (A8; aggregator contract-caller support is unverified). The router checks balances before and after, and it never trusts `swapData` return values. |
| RT-R4 | `closeShort` repays by *shares* (`repay(…, 0, borrowShares, …)`) to avoid dust debt, and refunds leftover tokens. |
| RT-R5 | The router holds no balances after any call. An invariant test asserts the router's token balances are 0 after every fuzzed flow. |
| RT-R6 | All user-facing functions take a `deadline`. Reentrancy is guarded. Events are emitted for the indexer (`ShortOpened`, `ShortClosed`, `Lent`, `Withdrawn`, `Borrowed`, `Repaid`, `CollateralAdded`, `CollateralWithdrawn`). |
| RT-R7 | Router upgrades go through the 48h timelock. The Morpho authorization UI tells users that the router can act on their Morpho positions, and how to revoke. |
| RT-R8 | *(new, remediation 2026-09-27)* `addCollateral` is a rescue top-up for positions with debt: it reverts `NoDebtPosition(onBehalf)` unless `onBehalf` has `borrowShares > 0` in that market. It needs no attestation, guard or cap check (risk-reducing, CP-R4) and anyone may top up anyone's position. All other collateral enters through attested entries (`borrow`, `openShort`); there is no collateral-only entry (`borrow` with `borrowAmount = 0` reverts in Morpho). Tests: `test_RT_R8_*` in [`StocklineRouter.t.sol`](../../contracts/test/router/StocklineRouter.t.sol), upgrade [`StocklineRouterUpgrade.t.sol`](../../contracts/test/router/StocklineRouterUpgrade.t.sol). |

## Acceptance criteria

- [x] Fork tests for every flow in the table, including partial fills and slippage failures ([`Router.fork.t.sol`](../../contracts/test/fork/phase1/Router.fork.t.sol): all flows through the live Morpho, Vault V2 and UniversalRouter, live-pool slippage failure; partial fills and a lying DEX in [`StocklineRouter.t.sol`](../../contracts/test/router/StocklineRouter.t.sol), which has no live counterpart for a partial fill).
- [x] Invariants CL-R6 and RT-R5 hold under 1M fuzz runs: `FOUNDRY_PROFILE=deep` runs 1,000 × 1,000 = 1M calls of every router flow with a misbehaving DEX ([`StocklineRouter.invariant.t.sol`](../../contracts/test/router/StocklineRouter.invariant.t.sol): RT-R5, CL-R6, LM-R7), plus 1M calls each for the standalone CL-R6 and LM-R7 suites (2026-09-27).
- [x] A liquidation of a router-opened position succeeds with a standard Morpho liquidator script that knows nothing about Stockline beyond `clUSDG.unwrap` ([`test_RT_routerPositionLiquidatableByStandardLiquidator`](../../contracts/test/router/StocklineRouter.t.sol)).
- [x] Gas: `openShort` ≤ 700k and `closeShort` ≤ 650k gas on Robinhood Chain (bound accepted 2026-09-27, Q3; the 600k placeholder is retired). **Measured on a fork (cold storage), 2026-09-27: `openShort` 643,746 (was ≈ 649k before the remediation's single debt read in the RT-R1 checks), `closeShort` 434,331.** The rest of the cost is the RT-R1 guard and t + 24h price reads (feeds, calendar, issuer flags); a combined oracle view would need new oracle deployments and therefore new Morpho markets, so it is not a cheap win.
- [x] *(Phase 4 session A3, engineering)* G5 receipt market (§3): stage 1 deploys the `rSTOCK`-collateral market, its oracle and the USDG vault with caps 0; the listing is the curator's timelocked step (six calls, CL-R10 window on 4663); borrow, exits under a tripped guard and liquidation paying `rNVDA` tested on the full local deployment ([`ReceiptMarket.t.sol`](../../contracts/test/deploy/ReceiptMarket.t.sol) 11) and on a 4663 fork ([`ReceiptMarket.fork.t.sol`](../../contracts/test/fork/phase3/ReceiptMarket.fork.t.sol)). Listing on mainnet: launch + 30 days, [runbook](../runbooks/list-receipt-market.md).
