# 03 · Stock lending markets

**Phase 1.** For each listed stock there is one isolated Morpho Blue market where the wrapped stock is the loan asset. Lenders
supply through a per-stock MetaMorpho vault, and its share token is the receipt (`rNVDA`). Launch markets: SPY, NVDA, AAPL.

## Scope

In:
- `StockWrapper` per stock.
- One Morpho market per stock: loan = `wSTOCK`, collateral = `clUSDG`.
- One MetaMorpho vault per stock (`rSTOCK`) with supply cap, idle reserve and performance fee.
- Allocator keeper.
- Deployment scripts and a market listing checklist.

Out: collateral wrapper and router (see [05](05-collateral-router.md)), oracle internals (see [04](04-oracle.md)).

## 1. StockWrapper

Morpho Blue assumes a standard ERC-20: no rebasing, no fee-on-transfer, no balance changes outside transfers. Stock Tokens
carry an ERC-8056 multiplier for corporate actions (splits, dividends in kind), and may carry transfer restrictions. The wrapper
isolates Morpho from both. Stock Tokens are plain 18-decimal ERC-20s; `uiMultiplier()` returns the effective multiplier
without a poke; there is no allowlist, but the issuer can blocklist addresses, pause transfers and force-burn balances (verified Phase 0, 2026-09-26).
See [`../phase0/01-chain-facts.md`](../phase0/01-chain-facts.md) §3.

| ID | Requirement |
|---|---|
| LM-R1 | `wrap(amount)` pulls `amount` raw Stock Token units and mints wrapper units 1:1 on the raw (pre-multiplier) balance. `unwrap(amount)` burns and returns raw units. |
| LM-R2 | Wrapper balances never change except by transfer, mint or burn. A corporate action changes the multiplier, not wrapper balances. |
| LM-R3 | `multiplier()` passes through the underlying token's ERC-8056 multiplier. `underlyingEquivalent(wrapped)` returns shares-of-stock after the multiplier. |
| LM-R4 | Decimals equal the underlying token's decimals. Name `Wrapped Stockline NVDA`, symbol `wNVDA`. |
| LM-R5 | No admin functions, no pause, no upgradeability. Anyone can unwrap at any time, including liquidators. |
| LM-R6 | If the underlying token has an allowlist, the wrapper must be allowlisted, and `unwrap` must revert with a clear error when the recipient is not allowed to hold the stock. |
| LM-R7 | Invariant: `underlying.balanceOf(wrapper) >= wrapper.totalSupply()` (raw units) at all times. Equality holds unless someone transfers the Stock Token to the wrapper directly without `wrap`; such tokens back no wrapper units and cannot be recovered (no admin, LM-R5). Tested by forge invariant test, including the exact form `balance == totalSupply + directTransfers`. |

Interface:

```solidity
interface IStockWrapper is IERC20Metadata {
    function underlying() external view returns (address);
    function wrap(uint256 rawAmount, address to) external returns (uint256 minted);
    function unwrap(uint256 amount, address to) external returns (uint256 rawOut);
    function multiplier() external view returns (uint256); // 1e18 = 1.0
    function underlyingEquivalent(uint256 amount) external view returns (uint256);
}
```

Open question: if a dividend is paid by *increasing the multiplier*, lenders get it automatically, because wrapped units are
worth more stock. Borrowers owe the same wrapped units, so they economically pay the dividend. This matches TradFi
"manufactured dividends". The app must explain it. If dividends are paid another way (airdrop, USDG), see
[12-open-questions](12-open-questions.md).

## 2. Morpho market per stock

| Param | Value at launch | Notes |
|---|---|---|
| `loanToken` | `wNVDA` | |
| `collateralToken` | `clUSDG` | Gated wrapper, see [05](05-collateral-router.md) |
| `oracle` | `StocklineOracle(NVDA)` | Returns price of 1 `clUSDG` in `wNVDA`, see [04](04-oracle.md) |
| `irm` | AdaptiveCurveIRM | Only IRMs enabled by Morpho governance are allowed. AdaptiveCurveIRM `0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1` and `irm = address(0)` are enabled (verified Phase 0, 2026-09-26) |
| `lltv` | 77% (0.77e18) | Must be a Morpho-enabled LLTV. Enabled: 0, 38.5%, 62.5%, 77%, 86%, 91.5%, 94.5%, 96.5%, 98% (verified Phase 0, 2026-09-26). Liquidation incentive 7.41% at 77% (LIF = 1/(1 − 0.3·0.23) = 1.07411) |

| ID | Requirement |
|---|---|
| LM-R10 | A deployment script creates the market with the exact params above and records the `Id` in `packages/sdk/addresses.json`. |
| LM-R11 | A fork test opens a position, accrues interest over 30 days, makes it unhealthy with a price move and liquidates it using the standard Morpho `liquidate()` path. |
| LM-R12 | A fork test confirms a liquidator can seize `clUSDG`, unwrap it to USDG, repay with `wNVDA` bought via `wrap`, all in one transaction via a callback. |
| LM-R13 | Interest accrues in `wNVDA`. All rate displays show APR/APY in stock terms and the USD equivalent at the current oracle price. |

## 3. Lender vault (MetaMorpho `rNVDA`)

Lenders do not supply to the Morpho market directly through the app. They deposit into a MetaMorpho vault whose share is
`rNVDA`. This gives a transferable ERC-4626 receipt, a supply cap and an idle reserve.

| Param | Value at launch |
|---|---|
| Asset | `wNVDA` |
| Name / symbol | `Stockline NVDA` / `rNVDA` |
| Enabled markets | (a) the NVDA stock-loan market, (b) an idle market (loan = `wNVDA`, no collateral, no oracle) |
| Supply queue | stock-loan market first, then idle |
| Withdraw queue | idle first, then stock-loan market |
| Cap on stock-loan market | Per [10-risk-compliance](10-risk-compliance.md), e.g. $1M notional in shares at launch |
| Performance fee | 10% of interest → `FeeSplitter` (lenders keep ~90%) |
| Timelock | 48h (curator changes) |

The router's `lend` flow wraps the stock and deposits into the vault in one transaction. Direct supply to the Morpho market is
possible (it is permissionless). The app won't offer it, and such supply gets no Stockline fee share or rewards.

| ID | Requirement |
|---|---|
| LM-R20 | `rNVDA` is a standard MetaMorpho (Morpho Vaults v1.1 or current) deployment. No forked vault code. |
| LM-R21 | The deposit cap is enforced by the vault's market caps (sum of market caps = max vault supply). The idle market cap is sized to hold the idle reserve. |
| LM-R22 | Withdrawals work whenever idle-market liquidity or unborrowed market liquidity is available. The app shows `maxWithdraw(user)` live. |

## 4. Allocator keeper (utilization cap and borrow pause)

Morpho Blue has no borrow cap and no pause. Stockline gets both by controlling how much lender liquidity sits in the market.

Target rule, per stock, every block or every 30s:

```
borrowed        = market.totalBorrowAssets
target_supply   = borrowed / U_MAX                     // U_MAX = 0.90 at launch
if guard_tripped: target_supply = borrowed / 0.999     // leave ~no free liquidity → no new borrows
move liquidity between the stock-loan market and the idle market so market supply ≈ target_supply,
bounded by the market cap and by vault assets.
```

| ID | Requirement |
|---|---|
| LM-R30 | The keeper keeps market utilization ≤ `U_MAX` (default 90%) whenever vault assets allow, so a share of lender assets stays in the idle market for withdrawals. |
| LM-R31 | When the oracle guard for that stock is tripped ([04](04-oracle.md)), the keeper reallocates all unborrowed liquidity to idle within 1 block. New borrows then fail for lack of liquidity. Repay, withdraw-collateral and liquidate still work. |
| LM-R32 | The guardian multisig can run the same "pull liquidity" action manually. |
| LM-R33 | The keeper is idempotent and restart-safe, and exposes `/health` with the last-run block per market. A miss longer than 5 minutes pages on-call. |
| LM-R34 | Reallocation never withdraws below what is needed to keep `market.totalSupply ≥ totalBorrow`. It respects Morpho rounding. Tested with fuzzed amounts. |

Note: when utilization is pushed near 100% during a guard trip, AdaptiveCurveIRM raises the borrow rate. That rate rise is
intended, because it pushes borrowers to close during a dislocation.

## 5. Listing a new stock (checklist)

1. Stock Token address, decimals, ERC-8056 support confirmed; transfer into wrapper and Morpho tested on fork.
2. Chainlink feed exists with a heartbeat ≤ 24h during market hours and known market-hours behavior.
3. DEX liquidity for the guard keeper: at least $250k depth within 2% (placeholder).
4. Historical volatility and weekend gap stats fed into the sim, which outputs the buffer params and cap.
5. Deploy wrapper, oracle, market, vault. Set caps through the timelock. Add to the SDK address book, indexer and app.
6. Announce 48h ahead. Start at 25% of the target cap.

## Acceptance criteria

- [ ] Forge tests: wrapper invariants (LM-R7), full lifecycle per market (LM-R11), liquidation with unwrap (LM-R12), allocator math fuzz (LM-R34).
- [ ] Testnet: 3 markets live; 20 external testers supply, borrow, repay, withdraw; allocator runs 7 days without a miss.
- [ ] Guard trip drill on testnet: liquidity pulled within 1 block; repay and liquidate still succeed.
