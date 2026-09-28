# List a receipt market (G5: `rSTOCK` → USDG)

**When:** a stock market has run **≥ 30 days on mainnet without a guard incident** (CL-R10), and the risk owner has
signed the receipt-market cap. **Who:** anyone deploys stage 1 (no power kept); the **curator multisig** lists
(stage 2) through the USDG vault's own 48h timelock. Spec: [05 §3](../prd/05-collateral-router.md), A3 of the Phase 4
session.

| Item | Value |
|---|---|
| Market | loan USDG, collateral `rSTOCK` (the stock's Vault V2 share), `ReceiptCollateralOracle`, AdaptiveCurveIrm, **LLTV 62.5%** |
| Oracle | `convertToAssets(1 share) × feed price × (1 − b(t)) / USDG price` (no multiplier, D1); params, guardian, keeper, sequencer feed and blocklist copied from the stock's oracle; owner = timelock |
| USDG supply | A Stockline USDG Vault V2 per receipt market (`sUSDG-rNVDA`), liquidity adapter = the market (no keeper), 10% performance fee → `FeeSplitter`, 48h timelocks, owner = timelock, curator = curator Safe, sentinel = guardian |
| Caps at stage 1 | **0** (the vault refuses deposits; nothing can be borrowed) |
| Listing | 6 curator actions: absolute cap to the listing cap and relative cap to 100% on the adapter, collateral and market ids |

## 0. Preconditions

- [ ] `CL-R10`: launch date of the stock market from the launch log (`STOCK_LAUNCH_TS`), ≥ 30 days ago, and no
      `GUARD_TRIPPED` incident on that stock since (monitor history / `GET /weekends`).
- [ ] Risk owner signed the listing cap (CL-R11: the sim shows liquidations stay profitable when the stock vault is
      at `U_MAX`; seized `rSTOCK` redeems for `wSTOCK` only up to vault liquidity).
- [ ] App copy for CL-R12 (recursion risk) is live behind `NEXT_PUBLIC_FEATURE_RECEIPT_MARKET`.
- [ ] Morpho Blue has LLTV 62.5% enabled (`isLltvEnabled(625000000000000000)`: true on 4663, checked by
      `ReceiptMarket.fork.t.sol`).

## 1. Stage 1: deploy (anyone; no role kept)

The deployer needs `2 × 1e6` raw USDG ($2 of seed) and gas.

```sh
cd contracts
# rehearsal on a fork of 4663 (no broadcast)
forge test --match-contract ReceiptMarketForkTest --fork-url $ROBINHOOD_RPC_URL
# mainnet, only with the owner's go
STOCKLINE_NETWORK=4663 TICKER=NVDA STOCK_LAUNCH_TS=<unix> I_HAVE_THE_OWNERS_GO=1 \
  forge script script/ListReceiptMarket.s.sol --rpc-url $ROBINHOOD_RPC_URL --broadcast --slow --verify \
  --sender <deployer> <hardware-wallet or remote-signer flags>
```

Output: `deployments/4663-receipt-NVDA.json` (oracle, `usdgVault`, `usdgAdapter`, `marketId`, `adapterMarketCapId`,
`lltv`). Copy it into `packages/sdk/addresses.json["4663"].stocks.NVDA.receipt` with the publish tool (scripts never
write the 4663 key), release the SDK. On 31337 / `fork-4663` the script writes the address book directly; on 46630
only with `TESTNET_GO=yes`.

Check: oracle `owner()` = timelock; vault `owner()` = timelock, `curator()` = curator Safe, `isSentinel(guardian)`,
deployer not an allocator, `timelock(increaseAbsoluteCap)` = 48h, every cap = 0, `liquidityAdapter()` = the adapter.

## 2. Stage 2: list (curator Safe, 48h)

```sh
cd packages/sdk
pnpm timelock receipt.list ticker=NVDA capUsdg=250000 launchTs=<unix> --network 4663
```

1. Curator Safe → USDG vault: the six `submitCalldata` (one Safe batch).
2. Announce; watch for `revoke` (the guardian can veto).
3. After 48h anyone sends the six `data` calls. Deposits into `sUSDG-rNVDA` are then lent to the market at once.

## 3. After listing

- The web panel (flag `NEXT_PUBLIC_FEATURE_RECEIPT_MARKET=1`) shows the market; entries are geo/terms-gated in the
  UI like borrow; repay and withdraw-collateral are exits (never gated; Morpho skips the price check once debt is 0).
- Raise the cap in ×2 steps only with the stock market's own cap schedule (10 launch parameters).
- Delist: curator `decreaseAbsoluteCap` to 0 (instant in Vault V2) stops new lending; existing loans run off.

## Evidence

`contracts/test/deploy/ReceiptMarket.t.sol` (11: wiring, deposits refused before listing, listing only through the
curator timelock, borrow at LLTV with the closure buffer, exits with the guard tripped, CL-R11 liquidation and
redeem, CL-R10 window, shared cap-id vector with the SDK), `test/fork/phase3/ReceiptMarket.fork.t.sol` (live 4663),
`packages/sdk/test/vaultTimelock.test.ts` (G5 listing, CL-R10).
