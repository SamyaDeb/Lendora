import {mulDivDown, WAD} from "./math/wad.js";
import {underlyingEquivalent} from "./math/wrapper.js";
import {toAssetsDown, utilization, type MorphoMarket} from "./math/morpho.js";
import {apy, aprWad, marketSupplyRate, vaultSupplyRate} from "./math/rates.js";

/**
 * The per-stock short-interest fields of docs/prd/07 §Definitions, computed from raw onchain values. The indexer, the
 * API and the dashboard all call this; `ShortInterestLens.snapshot()` computes the overlapping fields the same way
 * (SI-R20), which the API test checks at the same block.
 *
 * Scope: Stockline markets only (the stock-loan Morpho market and its `rSTOCK` Vault V2).
 */
export type MarketStatus = "open" | "closed" | "ramping" | "guard_tripped";

export interface ShortInterestInputs {
  /** Morpho market totals, accrued to the snapshot time (`expectedMarketBalances`). */
  market: MorphoMarket;
  /** wSTOCK held by the vault (unallocated, raw units). */
  vaultIdle: bigint;
  /** Morpho supply shares of the vault's market adapter. */
  adapterSupplyShares: bigint;
  /** ERC-8056 multiplier of the Stock Token (1e18 = 1.0), via `wrapper.multiplier()`. */
  multiplier: bigint;
  /** Chainlink answer in use by the oracle (`stockAnswer()`, feed decimals) = P_wrapped (D1). */
  stockAnswer: bigint;
  feedDecimals: number;
  /** `totalSupply()` of the Stock Token (raw units). */
  tokenTotalSupply: bigint;
  /** AdaptiveCurveIrm `borrowRateView` at the snapshot (per second, WAD). */
  borrowRatePerSec: bigint;
  /** Vault V2 performance fee (WAD). */
  performanceFee: bigint;
  /** Addresses with borrowShares > 0. */
  borrowers: number;
  /** Raw wSTOCK borrowed and covered (repaid + liquidated) in the last 24h. */
  borrowed24h: bigint;
  covered24h: bigint;
  /** DEX volume of the Stock Token (raw units) over the window, and the window length in days (≤ 30). Null = no
   * volume source on this network. */
  dexVolume?: {volume: bigint; days: number} | null;
  /** Oracle views at the snapshot. */
  guardReasons: bigint;
  bufferWad: bigint;
  marketOpen: boolean;
}

export interface ShortInterestFields {
  /** Shares of stock (1e18) after multiplier: market supply + vault idle. */
  suppliedShares: bigint;
  /** Shares of stock (1e18) after multiplier: market borrow (short interest). */
  borrowedShares: bigint;
  /** USD (WAD) of `totalBorrowAssets` at `P_wrapped` (no buffer). */
  borrowedUsd: bigint;
  /** Stock-loan market utilization (WAD). */
  utilization: bigint;
  /** `borrowed / supplied`, including the idle reserve (WAD). */
  utilizationVault: bigint;
  borrowRatePerSec: bigint;
  borrowApr: bigint;
  borrowApy: number;
  /** Lender APY through `rSTOCK`, net of the performance fee (display, variable). */
  supplyApy: number;
  supplyRatePerSec: bigint;
  /** `borrowed / Stock Token totalSupply` (raw/raw, WAD). */
  siPctFloat: bigint;
  /** Days of average DEX volume to cover the short interest; null without volume data. */
  daysToCover: number | null;
  borrowers: number;
  newShorts24h: bigint;
  covered24h: bigint;
  marketStatus: MarketStatus;
  /** USD per share of stock (WAD) at `P_wrapped`: feed price / multiplier. */
  priceUsd: bigint;
}

export function marketStatusOf(guardReasons: bigint, marketOpen: boolean, bufferWad: bigint): MarketStatus {
  if (guardReasons !== 0n) return "guard_tripped";
  if (!marketOpen) return "closed";
  return bufferWad > 0n ? "ramping" : "open";
}

export function shortInterestFields(i: ShortInterestInputs): ShortInterestFields {
  const m = i.market;
  const supplyRaw = m.totalSupplyAssets + i.vaultIdle;
  const toWad = 10n ** BigInt(18 - i.feedDecimals);
  const priceWad = i.stockAnswer * toWad; // USD per raw token (= per wrapped unit)
  const u = utilization(m);
  const allocated = toAssetsDown(i.adapterSupplyShares, m.totalSupplyAssets, m.totalSupplyShares);
  const supplyRate = vaultSupplyRate(marketSupplyRate(i.borrowRatePerSec, u, m.fee), allocated, i.vaultIdle + allocated, i.performanceFee);
  let daysToCover: number | null = null;
  if (i.dexVolume && i.dexVolume.volume > 0n && i.dexVolume.days > 0) {
    daysToCover = Number(m.totalBorrowAssets) / (Number(i.dexVolume.volume) / i.dexVolume.days);
  }
  return {
    suppliedShares: underlyingEquivalent(supplyRaw, i.multiplier),
    borrowedShares: underlyingEquivalent(m.totalBorrowAssets, i.multiplier),
    borrowedUsd: mulDivDown(m.totalBorrowAssets, priceWad, WAD),
    utilization: u,
    utilizationVault: supplyRaw > 0n ? mulDivDown(m.totalBorrowAssets, WAD, supplyRaw) : 0n,
    borrowRatePerSec: i.borrowRatePerSec,
    borrowApr: aprWad(i.borrowRatePerSec),
    borrowApy: apy(i.borrowRatePerSec),
    supplyApy: apy(supplyRate),
    supplyRatePerSec: supplyRate,
    siPctFloat: i.tokenTotalSupply > 0n ? mulDivDown(m.totalBorrowAssets, WAD, i.tokenTotalSupply) : 0n,
    daysToCover,
    borrowers: i.borrowers,
    newShorts24h: underlyingEquivalent(i.borrowed24h, i.multiplier),
    covered24h: underlyingEquivalent(i.covered24h, i.multiplier),
    marketStatus: marketStatusOf(i.guardReasons, i.marketOpen, i.bufferWad),
    priceUsd: i.multiplier > 0n ? mulDivDown(priceWad, WAD, i.multiplier) : 0n,
  };
}
