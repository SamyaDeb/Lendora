// Fixed-point helpers that mirror the rounding of OpenZeppelin `Math.mulDiv` and Morpho `MathLib`.
// All values are bigint in the same raw units the contracts use.

export const WAD = 10n ** 18n;

export function mulDivDown(x: bigint, y: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError("mulDivDown: division by zero");
  if (x < 0n || y < 0n || d < 0n) throw new RangeError("mulDivDown: negative input");
  return (x * y) / d;
}

export function mulDivUp(x: bigint, y: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError("mulDivUp: division by zero");
  if (x < 0n || y < 0n || d < 0n) throw new RangeError("mulDivUp: negative input");
  const p = x * y;
  return p === 0n ? 0n : (p - 1n) / d + 1n;
}
