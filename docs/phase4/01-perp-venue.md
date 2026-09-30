# Phase 4 · Task 12 · Perp venue research (08 open question, Q12)

Checked 2026-09-29 from public docs, the public Lighter API of the Robinhood Chain instance, and read-only calls to
Robinhood Chain (4663). No accounts were opened and nothing was signed.

**Conclusion.** Lighter's Robinhood Chain instance is the only venue with public evidence for everything PRD 08 needs:
SPY, NVDA and AAPL perps, hourly funding history through a public API, trading 24/7, and **margin accounts a smart
contract can own**. The contract registers the trading key onchain (`changePubKey`), and secure withdrawals go only to
the L1 address that owns the account. That satisfies DN-R10 for withdrawals. **One trust gap is left** (A40): an API
key can trade any market at any price, so an operator key could move value out through deliberately bad trades against
a counterparty it controls. The loss is bounded by the margin share, and the design contains it; it is not removed.
Arcus has no public docs on stock perps, APIs or contract-held accounts, so it stays `[VERIFY]`.

**Stop-and-ask check (task 12 rule):** not triggered. A venue that supports contract-held margin exists, with the
residual items below marked `[VERIFY]`.

## 1. Lighter (Robinhood Chain instance)

| Item | Finding | Status | Evidence |
|---|---|---|---|
| Venue contract | `ZkLighter` proxy `0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d` → implementation `0x82de5b1161c93afdfe21ba0d5343f01cd7401d90` (EIP-1967). Source **not verified** on Sourcify (4663) | VERIFIED onchain / source UNVERIFIED | `cast implementation`, Sourcify v2 `match: null` |
| Markets | Perps **SPY (26), NVDA (15), AAPL (10)**, all `active` | VERIFIED (public API) | `GET https://api.rh.lighter.xyz/api/v1/orderBookDetails` (2026-09-29) |
| Depth proxy (2026-09-29) | SPY: OI 67,316 (≈ $51.6M at $766.54), 24h volume $90.4M. NVDA: OI 28,647 (≈ $6.6M), $17.9M. AAPL: OI 7,279 (≈ $2.5M), $7.8M | VERIFIED (public API) | same |
| Fees | Standard account: **0 maker / 0 taker** (300 ms taker latency). Premium: 0.4 bp / 2.8 bp; Plus: 0.5 bp | VERIFIED (docs, API `taker_fee = 0`) | docs.lighter.xyz "Trading Fees" |
| Margin fractions | SPY initial 2% / maintenance 1.2% / close-out 0.8%; NVDA, AAPL 5% / 3% / 2% | VERIFIED (public API) | `orderBookDetails` `*_margin_fraction` (bps) |
| Liquidation | Below maintenance: liquidation by LLP (Lighter Liquidity Provider); below close-out: ADL. RWAs are liquidated like every other market | VERIFIED (docs) | docs.lighter.xyz "Liquidations & LLP", "Real World Assets" |
| Weekend trading | RWAs trade 24/7; leverage is unchanged outside trading hours. Hourly funding exists every hour incl. weekends (2,258 points in 94 days = 24/7) | VERIFIED (docs + API) | docs "Real World Assets"; `fundings` counts below |
| Weekend pricing | When oracle feeds are stale, index and mark prices switch to an internal order-book EMA (index τ = 30 min, mark τ = 2 min). **Oracle price caps were removed for SPY, NVDA and AAPL on 2026-07-10**, so weekend marks can move freely against the frozen Chainlink price | VERIFIED (docs) | docs "RWA Pricing Mechanism", "Price Cap Removal" |
| Funding | Hourly period; `GET /api/v1/fundings?market_id=…&resolution=1h` returns `rate`, `value`, `direction` | VERIFIED (public API) | e.g. NVDA latest `rate 0.0008, direction long` |
| **Funding history length** | **2026-06-26 → today (≈ 94 days, 2,258 hourly points) for all three markets.** Nothing earlier | VERIFIED (public API, paged back until empty) | see §3 |
| Collateral asset | USDG is asset index 3 = `QUOTE_ASSET_INDEX()` | VERIFIED onchain | `tokenToAssetIndex(USDG)`, `assetConfigs(3)` |
| **Contract-held account (DN-R10)** | Accounts are keyed by L1 address (`addressToAccountIndex(address)`); `deposit(address to, …)` credits any address; **API keys can be registered by calling `changePubKey(uint48,uint8,bytes)` on the contract** ("particularly helpful if you're running a multi-sig"). So a contract registers its own trading key with no ECDSA signature | VERIFIED (docs + onchain selector set) | apidocs.lighter.xyz/docs/api-keys; selectors `17010c68 changePubKey`, `8a857083 deposit`, `abf6a038 addressToAccountIndex` in the implementation |
| **Withdrawal destination (DN-R10)** | "only secure withdrawals can be executed without also signing the account's Ethereum private key, as they can only be sent to the **same L1 address that created the account**. Fast withdrawals and transfers can be sent to other L1 addresses and **require signing with the wallet's private key**." A contract has no private key, so an API key alone can move margin only back to the contract | VERIFIED (docs) | apidocs.lighter.xyz/docs/api-keys |
| L1 exits | Onchain priority requests: `withdraw(uint48,uint16,uint8,uint64)`, `createOrder(…)` (priority order), `cancelAllOrders(uint48)`; matured withdrawals are claimed with `withdrawPendingBalance(address owner,uint16,uint128)` / read with `getPendingBalance(address,uint16)`. `PRIORITY_EXPIRATION` = 1,209,600 s (14 days); escape hatch (`desertMode`, currently `false`) if the sequencer ignores priority requests | VERIFIED onchain (selectors, reads) | `cast call` on 4663 |
| Perp equity readable onchain (DN-R4) | **No.** Only the state root and matured pending balances are onchain; account equity and positions come from the API (`/api/v1/account`) | VERIFIED (selector set: no equity view) | → DN-R4 uses a **signed NAV report** (A41) |
| Third-party precedent | An open-source vault strategy (`LighterPerpStrategy`) claims a contract-owned account with a trade-only agent key, tested on a 4663 fork against the live ZkLighter: deposit USDG → register key → trade → force-close → withdraw to the contract | UNVERIFIED (third party) | github.com/sherwoodagent/sherwood-protocol/pull/3 |

### Residual `[VERIFY]` items (owner: Phase 4 eng lead, with Lighter)

1. **EIP-1271.** The docs don't say whether Lighter accepts an EIP-1271 contract signature as the "L1 signature" for
   transfers and fast withdrawals. Our adapter **must not implement `isValidSignature`**; then no L1 signature can
   exist for its account either way (A39).
2. **API-key permissions.** The docs don't list any per-key restrictions. We assume every key can trade any market
   and send secure withdrawals (which go back to the contract). If Lighter ever adds key scopes, register the
   operator key as trade-only.
3. **Instance parity.** The docs describe Lighter on Ethereum. The Robinhood Chain instance matches its selectors
   (same `ZkLighter` interface) but its source isn't verified. Ask Lighter for the verified source and the
   escape-hatch data availability on 4663.
4. **Contract registration end to end.** Live canary on 4663 with $10: adapter `deposit(to = adapter)` →
   `changePubKey` → trade 1 contract → `withdraw` → `withdrawPendingBalance`. Needs the sequencer, so a fork can't
   replace it. Owner go required.
5. **Withdrawal latency.** Secure withdrawals mature after the next verified batch (minutes to hours, undocumented).
   The vault's 72h queue (DN-R1) and the halt stress (72h) assume worst-case sequencer liveness plus the 14-day
   priority expiry → escape hatch.

## 2. Arcus

| Item | Finding | Status | Evidence |
|---|---|---|---|
| Venue | dYdX team's DEX on Robinhood Chain, live since 2026-07-01, > $2B cumulative volume | VERIFIED (press) | The Block 2026-08-25 |
| Stock perps | "Trade Stock Tokens 24/7"; leveraged stock pTokens (e.g. `pHOOD3x`). SPY/NVDA/AAPL perp listings, funding history API, margin rules: **not in public docs** | UNVERIFIED | arcus.xyz blog, The Block |
| pTokens | ERC-20 shares of a managed perp account at fixed market and leverage. A short 1× pToken would let a vault hold the hedge as a token (no margin account at all). Needs the pToken contracts and rebalancing rules | UNVERIFIED, worth checking | The Block, 2026-08-25 |
| Contract-held account | Unknown | `[VERIFY]` | owner: Phase 4 eng lead |

## 3. Data available for the simulation gate (task 13)

| Series | Source | Coverage | Enough for the gate (≥ 12 months)? |
|---|---|---|---|
| Perp funding, hourly, SPY/NVDA/AAPL | Lighter RH `fundings` | 2026-06-26 → 2026-09-29 (≈ 94 days) | **No** |
| Perp/spot basis | Lighter `candles` (mark, index) vs Chainlink rounds (`sim/data/feeds`) | ≈ 94 days (perps) | **No** |
| Borrow utilization / APY proxy | Lendora has no mainnet markets; Morpho stock-loan markets on 4663 are empty (01-chain-facts §8). Proxy: Phase 0 utilization assumptions and the AdaptiveCurve IRM at target | Modelled, not observed | **No** (proxy) |
| Weekend gaps | `sim/data` 10y daily closes | 10 years | Yes |
| DEX depth | `sim/data/dex_depth.csv` | snapshots 2026-09 | Yes (snapshot) |

So task 13 runs the model on the 94 days that exist and the 10-year gap history, and the verdict is **"insufficient
data"** until 12 months of funding exist (earliest 2027-06-26), with no silent extrapolation.

## 4. What this means for the design (task 14)

- **Venue-agnostic `IPerpAdapter`** + `MockPerpVenue` for every test. A `LighterPerpAdapter` is buildable (onchain
  calls confirmed) but is **not deployed anywhere** until the `[VERIFY]` items 1, 3 and 4 above are closed and the gate
  passes. It is a separate audit item.
- **DN-R10 enforcement lives in our contracts:** only the adapter owns the Lighter account; the adapter's `withdraw`
  can only queue a secure withdrawal (to itself) and forward matured balances to the vault; key registration
  (`changePubKey`) is a guardian/curator action, never the operator's; the guardian can rotate the key out
  (kill switch) and force-close through onchain priority orders.
- **The trust gap (A40) is bounded, not removed:** the operator key can trade on the venue. The worst case is the
  perp margin share `M = D(1 − c)/(L + 1)` (23.75% of NAV at `L = 3`, `c = 5%`). Mitigations: the NAV report's
  second signer above 1% moves (DN-R4), the `DN_NAV_STALE`/`DN_DELTA_BREACH` pages, the guardian's key rotation, and
  sleeve caps. Disclosed as a known issue in the Phase 4 audit package.
- **Perp equity for NAV (DN-R4)** comes from a signed report of `/api/v1/account` by the NAV reporter keeper, with a
  second signer above 1% (A41).

## Sources

- [Lighter API docs: API keys](https://apidocs.lighter.xyz/docs/api-keys)
- [Lighter docs (full text)](https://docs.lighter.xyz/llms-full.txt): fees, RWAs, RWA pricing, liquidations, escape hatch
- Lighter Robinhood Chain API: `https://api.rh.lighter.xyz/api/v1/orderBookDetails`, `/api/v1/fundings`
- Robinhood Chain RPC `https://rpc.mainnet.chain.robinhood.com` (read-only `eth_call`, `eth_getCode`)
- [sherwood-protocol PR #3: LighterPerpStrategy](https://github.com/sherwoodagent/sherwood-protocol/pull/3) (third party)
- [The Block: Arcus pTokens (2026-08-25)](https://www.theblock.co/news/defi/2026-08-25-robinhood-chain-dex-arcus-ptokens-perps-erc-20s-412696)
- `docs/phase0/01-chain-facts.md` §7
