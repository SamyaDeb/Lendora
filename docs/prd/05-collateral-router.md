# 05 · Collateral and router

**Phase 1.** Borrowers post `clUSDG`, a gated wrapper around USDG or a yield-bearing USDG vault share. It is minted only
through the router, and that gives Stockline one place to enforce caps, geo-rules and the guard. `StocklineRouter` bundles
every user flow into one transaction.

## 1. Why gated collateral

Morpho Blue markets are permissionless. Anyone holding the collateral token can borrow directly. If collateral were plain
USDG, Stockline could not enforce per-user limits or pause new positions. With `clUSDG`:

- New collateral enters only through the router, which checks guard state, caps and attestation.
- Exit is always permissionless: anyone holding `clUSDG` can unwrap to the backing asset, so liquidators are never blocked.

This is a soft gate: an existing borrower can still borrow more against collateral already posted. Hard limits come from
the liquidity controls in [03 §4](03-lending-markets.md).

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
| `addCollateral`, `repay`, `withdrawCollateral` | single-step helpers | US-B5 |

| ID | Requirement |
|---|---|
| RT-R1 | *(restated D5, D8)* `borrow` and `openShort` revert if the oracle guard is tripped, if the user's resulting health factor at `t + 24h` (including the upcoming closure **and event** buffers, assuming no fresh round) is below `HF_MIN_OPEN = 1.10`, if the user's debt in that market would exceed the per-address cap (D8: SPY $75k, NVDA $250k, AAPL $35k, valued at the feed price; larger limits by owner allowlist for known market makers), or if the global `clUSDG` cap would be exceeded. |
| RT-R2 | `borrow` and `openShort` require a valid attestation (EIP-712 signature from the compliance signer, bound to user, chain and expiry). Other flows (repay, close, withdraw) never require one. See [10](10-risk-compliance.md). |
| RT-R3 | Swaps go only through allowlisted targets with user-set slippage (`minOut`/`maxIn`), starting with Uniswap's UniversalRouter (A8; aggregator contract-caller support is unverified). The router checks balances before and after, and it never trusts `swapData` return values. |
| RT-R4 | `closeShort` repays by *shares* (`repay(…, 0, borrowShares, …)`) to avoid dust debt, and refunds leftover tokens. |
| RT-R5 | The router holds no balances after any call. An invariant test asserts the router's token balances are 0 after every fuzzed flow. |
| RT-R6 | All user-facing functions take a `deadline`. Reentrancy is guarded. Events are emitted for the indexer (`ShortOpened`, `ShortClosed`, `Lent`, `Withdrawn`, `Borrowed`, `Repaid`, `CollateralAdded`, `CollateralWithdrawn`). |
| RT-R7 | Router upgrades go through the 48h timelock. The Morpho authorization UI tells users that the router can act on their Morpho positions, and how to revoke. |

## Acceptance criteria

- [ ] Fork tests for every flow in the table, including partial fills and slippage failures.
- [ ] Invariants CL-R6 and RT-R5 hold under 1M fuzz runs.
- [ ] A liquidation of a router-opened position succeeds with a standard Morpho liquidator script that knows nothing about Stockline beyond `clUSDG.unwrap`.
- [ ] Gas: `openShort` ≤ 600k and `closeShort` ≤ 650k gas on Robinhood Chain (placeholder; measure on fork).
