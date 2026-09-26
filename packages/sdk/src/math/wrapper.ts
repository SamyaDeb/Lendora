import {mulDivDown, WAD} from "./wad.js";

/**
 * Shares of the underlying stock represented by `wrapped` wrapper units (raw Stock Token units), given the
 * token's ERC-8056 `uiMultiplier()` (1e18 = 1.0). Mirrors `StockWrapper.underlyingEquivalent` (LM-R3): rounds down.
 */
export function underlyingEquivalent(wrapped: bigint, multiplier: bigint): bigint {
  return mulDivDown(wrapped, multiplier, WAD);
}
