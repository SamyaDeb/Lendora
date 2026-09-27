import {mulDivDown, WAD} from "./wad.js";

/**
 * Rate conventions for display (LM-R13, CP-R7: every APY in the app is labeled "variable"). Morpho accrues per second
 * with `wTaylorCompounded`; APR is `rate · 365 days` (exact, WAD) and APY is `e^(rate · 365 days) − 1` (float, display
 * only; never used for safety numbers).
 */
export const SECONDS_PER_YEAR = 365n * 86_400n;

/** Simple annual rate, WAD. */
export function aprWad(ratePerSec: bigint): bigint {
  return ratePerSec * SECONDS_PER_YEAR;
}

/** Continuously compounded annual yield as a fraction (0.05 = 5%). */
export function apy(ratePerSec: bigint): number {
  return Math.expm1((Number(ratePerSec) * Number(SECONDS_PER_YEAR)) / 1e18);
}

/** Market supply rate per second: `borrowRate · utilization · (1 − fee)`, WAD. */
export function marketSupplyRate(borrowRate: bigint, utilizationWad: bigint, feeWad: bigint): bigint {
  return mulDivDown(mulDivDown(borrowRate, utilizationWad, WAD), WAD - feeWad, WAD);
}

/**
 * Lender rate of a Vault V2 `rSTOCK` (07: "supply APY is net of the vault performance fee"): the market supply rate on
 * the allocated part, diluted by the idle reserve, minus the performance fee. `vaultAssets` = idle + allocated.
 */
export function vaultSupplyRate(marketRate: bigint, allocatedAssets: bigint, vaultAssets: bigint, performanceFeeWad: bigint): bigint {
  if (vaultAssets === 0n) return 0n;
  return mulDivDown(mulDivDown(marketRate, allocatedAssets, vaultAssets), WAD - performanceFeeWad, WAD);
}

/** The borrow rate at a hypothetical utilization, for the preview's "rate at +10% utilization" (06). */
export function utilizationPlus(utilizationWad: bigint, deltaWad: bigint): bigint {
  const u = utilizationWad + deltaWad;
  return u > WAD ? WAD : u;
}
