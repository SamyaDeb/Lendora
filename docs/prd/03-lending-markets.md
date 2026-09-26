# 03 · Stock lending markets

**Phase 1.** For each listed stock there is one isolated Morpho Blue market where the wrapped stock is the loan asset. Lenders
supply through a per-stock Morpho Vault V2 (D6), and its share token is the receipt (`rNVDA`). Launch markets: SPY, NVDA, AAPL.

## Scope

In:
- `StockWrapper` per stock.
- One Morpho market per stock: loan = `wSTOCK`, collateral = `clUSDG`.
- One Morpho Vault V2 per stock (`rSTOCK`, official factory) with a `MorphoMarketV1AdapterV2`, supply caps, an idle reserve
  and a performance fee (D6).
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
| LM-R5 | *(restated D10 R2)* No admin functions, no pause, no upgradeability. Anyone can unwrap, including liquidators, **whenever the Stock Token allows transfers**: the issuer's per-token or global pause, or a blocklisting of the wrapper or the recipient, makes `unwrap` revert (verified Phase 0 fork tests). The oracle guard trips when the token is paused or the wrapper is blocked (D4, [04 §4](04-oracle.md)). |
| LM-R6 | *(restated D10 R3)* The Stock Token has no allowlist; the issuer's blocklist makes the token itself revert `Blocked(recipient)` (verified Phase 0). Wrappers deploy with `holderAllowlist = address(0)`. An optional `BlocklistHolderAllowlist` adapter (`isAllowed(to) = !registry.isBlocked(to)`) gives a pre-check with our own `RecipientNotAllowed` error. |
| LM-R7 | *(restated D10 R1)* Invariant, **absent issuer `adminBurn`**: `underlying.balanceOf(wrapper) >= wrapper.totalSupply()` (raw units). Equality holds unless someone transfers the Stock Token to the wrapper directly without `wrap`; such tokens back no wrapper units and cannot be recovered (no admin, LM-R5). The issuer's `adminBurn(wrapper, x)` bypasses pause and blocklist and breaks it: the last unwrappers revert (fork test `adminBurnFromWrapper_breaksLMR7`). Tested by forge invariant test with mocks, including `balance == totalSupply + directTransfers`, plus a test of the `adminBurn` failure mode. |
| LM-R8 | *(new, D10 R1)* `backingShortfall()` view returns `max(0, totalSupply − underlying.balanceOf(wrapper))`. Monitoring pages P0 when it is non-zero ([10](10-risk-compliance.md)). |

Interface:

```solidity
interface IStockWrapper is IERC20Metadata {
    function underlying() external view returns (address);
    function holderAllowlist() external view returns (address);
    function backingShortfall() external view returns (uint256); // LM-R8
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

## 3. Lender vault (Morpho Vault V2 `rNVDA`, D6)

Lenders do not supply to the Morpho market directly through the app. They deposit into a Morpho Vault V2 whose share is
`rNVDA`. This gives a transferable ERC-4626 receipt, supply caps and an idle reserve. No MetaMorpho v1 factory exists on
Robinhood Chain; the Vault V2 factory is live with 70 vaults (verified Phase 0, [01 §2](../phase0/01-chain-facts.md#2-morpho)).

| Param | Value at launch |
|---|---|
| Vault | `VaultV2` from the official `VaultV2Factory` `0x0FBad98595b0186dA120E41f77C102beb49f803c` |
| Asset | `wNVDA` |
| Name / symbol | `Stockline NVDA` / `rNVDA` |
| Adapter | One `MorphoMarketV1AdapterV2` from the official factory `0x79370Ed003CE325C088E530d5e8655c99c2993e1`, used only for the NVDA stock-loan market (the adapter requires the AdaptiveCurveIRM) |
| Idle reserve | The vault's own unallocated balance. **No idle market** (LM-R21 retired) |
| Liquidity adapter | None. Deposits stay idle until the allocator allocates, so a deposit during a guard trip adds no borrowable liquidity; withdrawals are served from idle, or via `forceDeallocate` (LM-R22) |
| Absolute caps | On all three adapter ids (adapter, `collateralToken = clUSDG`, market params): the launch cap from [10](10-risk-compliance.md), converted to `wNVDA` at the listing price |
| Relative cap | `U_MAX` (90%) on the market id: allocation ≤ 90% of vault assets at every allocation |
| Performance fee | 10% of interest → `FeeSplitter` (lenders keep ~90%) |
| `maxRate` | Set by the allocator at deployment (Vault V2 defaults to 0, which would stop interest reaching the share price) |
| `forceDeallocate` penalty | 0 (in-kind exit is free; misuse can only pull liquidity, which pauses new borrows until the allocator re-allocates) |
| Timelocks | 48h on every curator action that can hurt depositors (adapters, cap increases, allocators, gates, fees, penalty, timelock decreases); cap decreases and `revoke` are instant |
| Roles | Owner = timelock; curator = multisig; allocators = keeper EOA + multisig; sentinel = guardian ([02](02-architecture.md)) |
| Gates | None at launch; a receive-shares gate can enforce geo-attestation later if counsel requires it (06 C1) |

The router's `lend` flow wraps the stock and deposits into the vault in one transaction. Direct supply to the Morpho market is
possible (it is permissionless). The app won't offer it, and such supply gets no Stockline fee share or rewards.

| ID | Requirement |
|---|---|
| LM-R20 | *(restated D6)* `rNVDA` is a Morpho Vault V2 created by the official `VaultV2Factory`, with a `MorphoMarketV1AdapterV2` from the official adapter factory. No forked vault code. The `vault-v2` submodule is pinned to the commit whose sources match the onchain factory (tag `2025-12-04`, `425f6b1`), and a fork test compares the runtime code of a vault built from the pinned source with one from the live factory. |
| LM-R21 | *(retired, D6)* Idle market. Replaced by LM-R23. |
| LM-R22 | *(restated D6)* Withdrawals work whenever the vault's idle balance covers them. Otherwise any holder can `forceDeallocate` free market liquidity into the vault (penalty 0) and redeem; the router's `withdrawLend` does this in the same transaction. Vault V2's `max*` views always return 0, so the app shows `withdrawable = min(user assets, idle + market free liquidity)` from the SDK. |
| LM-R23 | *(new, D6)* Supply caps and idle reserve use Vault V2 caps: absolute caps on the adapter, collateral and market ids bound the allocation; the relative cap `U_MAX` on the market id keeps at least `(1 − U_MAX)` of `totalAssets` idle at every allocation. |

## 4. Allocator keeper (utilization cap and borrow pause)

Morpho Blue has no borrow cap and no pause. Stockline gets both by controlling how much lender liquidity sits in the market,
using Vault V2's `allocate` / `deallocate` (D6).

Target rule, per stock, every block or every 30s:

```
idle_target   = (1 − U_MAX) · vault.totalAssets                 // U_MAX = 0.90 at launch
room          = min(absoluteCaps − allocation, U_MAX · totalAssets − allocation)
free          = min(adapter supply assets, market.totalSupply − market.totalBorrow)   // what deallocate can take
if guard_tripped or pre-event pull window (D5):  deallocate(free)                     // no new borrows possible
else if idle > idle_target:                     allocate(min(idle − idle_target, room))
else if idle < idle_target:                     deallocate(min(idle_target − idle, free))
```

| ID | Requirement |
|---|---|
| LM-R30 | *(restated D6)* The keeper keeps vault-level utilization ≤ `U_MAX` (default 90%) whenever vault assets allow: the relative cap enforces it at allocation, and the keeper restores the idle reserve after withdrawals and allocates new deposits. |
| LM-R31 | *(restated D6, D5)* When the oracle guard for that stock is tripped ([04](04-oracle.md)), the keeper `deallocate`s all free market liquidity within 1 block. It does the same from `PULL_LEAD` before an event window until the event buffer is released (NVDA, AAPL; D5). New borrows then fail for lack of liquidity. Repay, withdraw-collateral and liquidate still work. |
| LM-R32 | *(restated D6)* The guardian is the vault's Sentinel: it can `deallocate` and decrease caps without a timelock, so it can run the same "pull liquidity" action manually. |
| LM-R33 | The keeper is idempotent and restart-safe, and exposes `/health` with the last-run block per market. A miss longer than 5 minutes pages on-call. |
| LM-R34 | *(restated D6)* Deallocation never exceeds free market liquidity or the adapter's position (`min(adapter supply assets, totalSupply − totalBorrow)`), and respects Morpho rounding. Tested with fuzzed amounts. |

Note: when utilization is pushed near 100% during a guard trip, AdaptiveCurveIRM raises the borrow rate. That rate rise is
intended, because it pushes borrowers to close during a dislocation.

## 5. Listing a new stock (checklist)

Operational version: [`docs/runbooks/list-stock.md`](../runbooks/list-stock.md).

1. Stock Token address, decimals, ERC-8056 support confirmed; transfer into wrapper and Morpho tested on fork; issuer admin powers (blocklist, pause, `adminBurn`) re-checked.
2. Chainlink feed exists with a heartbeat ≤ 24h during market hours and known 24/5 behavior; `oraclePaused()` readable on the token.
3. DEX liquidity for the guard keeper and liquidations: 2% depth measured; the launch and per-address caps follow from it (D8: per-address ≈ 25% of 2% depth).
4. Historical volatility, weekend and earnings gap stats fed into the sim, which outputs σ, z, event buffers and cap.
5. Earnings calendar entries (if a single stock) added to `packages/sdk/data/events.json` and pushed to `MarketHours`.
6. Deploy wrapper, oracle, market, Vault V2 + adapter (`script/DeployStock.s.sol`). Caps, timelocks and roles set by the script; cap increases later go through the 48h timelock. Add to the SDK address book, indexer and app.
7. Announce 48h ahead. Start at 25% of the target cap.

## Acceptance criteria

- [ ] Forge tests: wrapper invariants (LM-R7) and `backingShortfall` (LM-R8), full lifecycle per market (LM-R11), liquidation with unwrap (LM-R12), allocator math fuzz (LM-R34), Vault V2 code-hash check (LM-R20).
- [ ] Testnet: 3 markets live; 20 external testers supply, borrow, repay, withdraw; allocator runs 7 days without a miss.
- [ ] Guard trip drill on testnet: liquidity pulled within 1 block; repay and liquidate still succeed.
