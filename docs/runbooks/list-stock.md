# Runbook · List a new stock

Operational version of [03 §5](../prd/03-lending-markets.md#5-listing-a-new-stock-checklist). Every onchain step is in
`contracts/script/LendoraDeploy.sol` (`_deployStock`); the governance steps go through the 48h timelock.
Phase 1 only runs this on anvil and on forks. Nothing here broadcasts to Robinhood Chain until Phase 3.

## 0. Go / no-go inputs (offchain)

| Check | How | Pass |
|---|---|---|
| Stock Token facts | `cast call <token> "decimals()"`, `uiMultiplier()`, `oraclePaused()`, `paused()`; fork test like `StockTokenTransfer` with the new token | 18 dp, ERC-8056 readable, exact transfers into the wrapper and Morpho |
| Issuer powers | Registry role holders unchanged (`docs/phase0/01-chain-facts.md` §3.2) | No new power over holders |
| Chainlink feed | Listed in `external-addresses.json` with `marketHours: us_equities_24/5`, 8 dp, 0.5% / 24h | Feed exists and includes the multiplier (D1) |
| DEX depth | `sim/phase0/dex_depth.py` on a **weekday** and a Saturday | Per-address cap ≈ 25% of the 2% depth (D8) |
| Volatility, gaps, earnings | Sim: 5y σ, 10y weekend gaps, 10y earnings gaps | σ, z, event buffer, launch cap signed off by the risk owner |
| Earnings calendar | Add entries to `packages/sdk/data/events.json` (single stocks only), `pnpm --filter @lendora/sdk gen:sessions` | Dates confirmed by the company's IR page (`confirmed: true`) |

## 1. Deploy (per stock)

1. Add the stock to `script/ForkConfig.sol` (`forkStocks`) with σ, launch cap (USD) and per-address cap (USD).
2. Fund the deployer with `2 × SEED` raw Stock Token units (seed of the market and the vault against share inflation).
3. Simulate on a fork: `forge script script/DeployFork.s.sol --fork-url $ROBINHOOD_RPC_URL --sender <deployer>` and
   check `packages/sdk/addresses.json` → `fork-4663`.
4. Run the fork suite: `ROBINHOOD_RPC_URL=… forge test --mp "test/fork/phase1/*"` (code hash, wiring, flows).
5. The script then deploys, in order: `StockWrapper` → `LendoraOracle` (owner = timelock) → Morpho market
   (wSTOCK / clUSDG, AdaptiveCurveIRM, LLTV 77%) seeded for `0xdead` → Vault V2 from the official factory →
   `MorphoMarketV1AdapterV2` from the official factory → caps (absolute = launch cap at the listing price on all three
   adapter ids; relative = 90% `U_MAX`) → `performanceFeeRecipient = FeeSplitter`, then `performanceFee = 10%`
   (FE-R1; both **before** the timelocks, so no 48h wait at listing; the splitter itself is deployed once in
   `_deployCore`, owned by the timelock) → `maxRate` → vault seeded for
   `0xdead` → adapter and vault timelocks 48h → sentinel = guardian, curator = multisig, owner = timelock.

## 2. Wire (timelock proposals, 48h)

| Proposal | Target |
|---|---|
| `LendoraRouter.listMarket(stock, …)` with the per-address cap | Router (task 8) |
| `MarketHours.replaceEventsFrom(stock, …)` if the stock has earnings windows | MarketHours |
| Keeper configs: add the vault/adapter to the allocator, the pools to the guard keeper, the market to the liquidator | Ops (no timelock) |

## 2b. Fees on a vault deployed without them (FE-R1; testnet 46630)

Testnet vaults were deployed with `fee = 10%` to a keyless placeholder. Point them at the `FeeSplitter` through the
vault's **own** curator timelock (24h testnet, 48h mainnet; not the `TimelockController`):

```sh
pnpm --filter @lendora/sdk timelock vault.setPerformanceFeeRecipient ticker=NVDA recipient=$(addr '.feeSplitter') --network $NET
# 1. curator → vault: submitCalldata   2. wait: cast call $VAULT "executableAt(bytes)(uint256)" <data>
# 3. anyone → vault: data               veto before 3: curator or guardian → vault: revokeCalldata
cast call $VAULT "performanceFeeRecipient()(address)" --rpc-url $RPC      # = FeeSplitter
```

Then fees accrue on every interaction (`accrueInterest`); anyone calls `FeeSplitter.distribute(vault)`. Rehearsed on
anvil: `packages/devnet/test/runbooks.test.ts` ("list-stock.md fees").

## 3. Launch

1. Announce 48h ahead.
2. Start the allocator at 25% of the target cap (curator lowers the absolute cap instantly; raising back is timelocked).
3. Watch the first weekend: ramp-in at Friday 16:00 ET, hold, release on the first Sunday 20:00 ET round.
4. Raise caps ×2 only after 2 weekends without a guard incident and a sim rerun (10-risk).

## 4. Verify after deploy

| Check | Expected |
|---|---|
| `vault.owner()` / `curator()` / `isSentinel(guardian)` | timelock / multisig / true |
| `vault.timelock(addAdapter / increaseAbsoluteCap / setIsAllocator / setPerformanceFee / increaseTimelock)` | 172800 |
| `vault.liquidityAdapter()` | `0x0` (deposits idle until allocated) |
| `vault.maxRate()` | `200e16 / 365 days` |
| `vault.performanceFee()` / `performanceFeeRecipient()` | `1e17` / `FeeSplitter` (FE-R1) |
| `vault.timelock(setPerformanceFeeRecipient)` | 172800 |
| `FeeSplitter.owner()` / `recipients()` | timelock / treasury 5,000 + `BackstopReserve` 5,000 bps (Q8, FE-R3) |
| `oracle.price()` vs feed | `1e48 / (answer · (1 + b))` for USDG = $1 |
| `oracle.guardTripped()` | false (unless the market is closed and stale) |
| `wrapper.backingShortfall()` | 0 (P0 page otherwise) |
| `marketHours.lastSessionClose()` | ≥ 14 days ahead |
