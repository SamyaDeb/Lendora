import {mulDivDown, mulDivUp, WAD} from "./wad.js";
import {adaptiveCurveBorrowRate} from "./irm.js";

/**
 * Morpho Blue share and interest math, mirroring `SharesMathLib`, `MathLib.wTaylorCompounded` and
 * `MorphoBalancesLib.expectedMarketBalances` (v1.0.0) operation for operation, so indexed and API values equal what
 * the contracts and `ShortInterestLens` compute (SI-R20). Vectors: `contracts/test/vectors/morpho.json`.
 */

export const VIRTUAL_SHARES = 10n ** 6n;
export const VIRTUAL_ASSETS = 1n;

export function toSharesDown(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivDown(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
}
export function toAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivDown(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}
export function toSharesUp(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivUp(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
}
export function toAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}

/** `x·n + (x·n)²/2 + (x·n)³/6`, WAD (MathLib.wTaylorCompounded). */
export function wTaylorCompounded(x: bigint, n: bigint): bigint {
  const first = x * n;
  const second = mulDivDown(first, first, 2n * WAD);
  const third = mulDivDown(second, first, 3n * WAD);
  return first + second + third;
}

/** Morpho `Market` storage struct. */
export interface MorphoMarket {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
}

/**
 * Market totals with interest accrued to `timestamp` (MorphoBalancesLib.expectedMarketBalances) for a market whose
 * IRM is the AdaptiveCurveIrm with stored `rateAtTarget` (0 before the first accrual). `irmEnabled = false` models
 * `irm = address(0)` (no interest).
 */
export function expectedMarketBalances(m: MorphoMarket, rateAtTarget: bigint, timestamp: bigint, irmEnabled = true): MorphoMarket {
  const elapsed = timestamp - m.lastUpdate;
  const out = {...m};
  if (elapsed !== 0n && m.totalBorrowAssets !== 0n && irmEnabled) {
    const borrowRate = adaptiveCurveBorrowRate(m, rateAtTarget, timestamp).avgRate;
    const interest = mulDivDown(m.totalBorrowAssets, wTaylorCompounded(borrowRate, elapsed), WAD);
    out.totalBorrowAssets += interest;
    out.totalSupplyAssets += interest;
    if (m.fee !== 0n) {
      const feeAmount = mulDivDown(interest, m.fee, WAD);
      const feeShares = toSharesDown(feeAmount, out.totalSupplyAssets - feeAmount, out.totalSupplyShares);
      out.totalSupplyShares += feeShares;
    }
  }
  return out;
}

/** Morpho utilization `totalBorrowAssets.wDivDown(totalSupplyAssets)` (0 for an empty market), WAD. */
export function utilization(m: Pick<MorphoMarket, "totalSupplyAssets" | "totalBorrowAssets">): bigint {
  return m.totalSupplyAssets > 0n ? mulDivDown(m.totalBorrowAssets, WAD, m.totalSupplyAssets) : 0n;
}

/** Morpho liquidation incentive factor `min(1.15, 1 / (1 − 0.3·(1 − LLTV)))`, WAD (ConstantsLib + Morpho.liquidate). */
export function liquidationIncentiveFactor(lltv: bigint): bigint {
  const cursor = 3n * 10n ** 17n;
  const lif = mulDivDown(WAD, WAD, WAD - mulDivDown(cursor, WAD - lltv, WAD));
  const max = 115n * 10n ** 16n;
  return lif < max ? lif : max;
}
