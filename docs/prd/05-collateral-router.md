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
| CL-R5 | No pause on `unwrap` and no admin that can seize or freeze balances. |
| CL-R6 | Invariant: backing balance of `clUSDG` ≥ `totalSupply` (in backing units). |

**Yield on collateral (short rebate).** With a vault-share backing, the share price rises while it sits in Morpho as
collateral, so the borrower's health improves over time and they keep the yield on unwrap. [VERIFY] which USDG yield
vaults exist on Robinhood Chain and whether their share price can ever fall. If it can, the oracle must use a
manipulation-resistant rate and the LLTV must be lower.

## 3. Receipt as collateral (G5, `rSTOCK` → USDG)

Lenders can post `rNVDA` to borrow USDG. This uses a second Morpho market per stock:

| Param | Value |
|---|---|
| loanToken | USDG |
| collateralToken | `rNVDA` (MetaMorpho share, not gated) |
| oracle | `ReceiptCollateralOracle(NVDA)` with collateral haircut `(1 − b(t))` |
| LLTV | 62.5% at launch |
| USDG supply | Stockline-curated MetaMorpho USDG vault, or an existing USDG vault that opts in [VERIFY] |

| ID | Requirement |
|---|---|
| CL-R10 | The market is listed only after the stock-loan market has run 30 days on mainnet without a guard incident. |
| CL-R11 | Seized `rNVDA` can be redeemed by liquidators for `wNVDA` up to vault liquidity. The sim must show liquidations stay profitable when the NVDA vault is at `U_MAX`. |
| CL-R12 | The app shows the recursion risk: `rNVDA` value falls if NVDA falls *and* if the lending vault can't return liquidity. |

## 4. StocklineRouter

The router is stateless between transactions. Users grant it Morpho authorization (`setAuthorization`) once and approve
tokens via Permit2 or EIP-2612 where available.

| Flow | Steps (all in one tx) | Story |
|---|---|---|
| `lend(stock, amount)` | pull Stock Token → wrap → deposit into `rSTOCK` → shares to user | US-L1 |
| `withdrawLend(stock, shares)` | redeem `rSTOCK` → unwrap → Stock Token to user | US-L3 |
| `borrow(stock, collateralIn, borrowAmt)` | pull USDG → mint `clUSDG` → `supplyCollateral` onBehalf user → `borrow` onBehalf user → unwrap → Stock Token to user | US-B1 |
| `openShort(stock, collateralIn, borrowAmt, minUsdgOut, swapData)` | as `borrow`, then swap Stock Token → USDG via an allowlisted aggregator; USDG to user (or add to collateral if `compound=true`) | US-B2 |
| `closeShort(stock, maxUsdgIn, swapData)` | pull USDG → swap to Stock Token → wrap → `repay` all shares → `withdrawCollateral` → unwrap `clUSDG` → USDG to user | US-B4 |
| `addCollateral`, `repay`, `withdrawCollateral` | single-step helpers | US-B5 |

| ID | Requirement |
|---|---|
| RT-R1 | `borrow` and `openShort` revert if the oracle guard is tripped, if the user's resulting health factor at `t + 24h` (including the upcoming buffer) is below `HF_MIN_OPEN = 1.10`, or if per-address or global collateral caps would be exceeded. |
| RT-R2 | `borrow` and `openShort` require a valid attestation (EIP-712 signature from the compliance signer, bound to user, chain and expiry). Other flows (repay, close, withdraw) never require one. See [10](10-risk-compliance.md). |
| RT-R3 | Swaps go only through allowlisted aggregator targets with user-set slippage (`minOut`/`maxIn`). The router checks balances before and after, and it never trusts `swapData` return values. |
| RT-R4 | `closeShort` repays by *shares* (`repay(…, 0, borrowShares, …)`) to avoid dust debt, and refunds leftover tokens. |
| RT-R5 | The router holds no balances after any call. An invariant test asserts the router's token balances are 0 after every fuzzed flow. |
| RT-R6 | All user-facing functions take a `deadline`. Reentrancy is guarded. Events are emitted for the indexer (`ShortOpened`, `ShortClosed`, `Lent`, `Withdrawn`). |
| RT-R7 | Router upgrades go through the 48h timelock. The Morpho authorization UI tells users that the router can act on their Morpho positions, and how to revoke. |

## Acceptance criteria

- [ ] Fork tests for every flow in the table, including partial fills and slippage failures.
- [ ] Invariants CL-R6 and RT-R5 hold under 1M fuzz runs.
- [ ] A liquidation of a router-opened position succeeds with a standard Morpho liquidator script that knows nothing about Stockline beyond `clUSDG.unwrap`.
- [ ] Gas: `openShort` ≤ 600k and `closeShort` ≤ 650k gas on Robinhood Chain (placeholder; measure on fork).
