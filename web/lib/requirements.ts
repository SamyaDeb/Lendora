import {HF_MIN_OPEN_WAD, OPEN_HORIZON_SEC, healthFactorAt} from "@stockline/sdk";
import {currentDebt, stockMarketState, type MarketChainState} from "./chain";

/**
 * Smallest extra USDG collateral (6 dp) so the position's health factor at `t` is ≥ `target`, for a new borrow of
 * `borrowAmount` (raw stock). Binary search on the SDK health factor, like `maxBorrowFor`. Read-only: display only.
 */
export function minCollateralFor(s: MarketChainState, borrowAmount: bigint, t: bigint, target: bigint = HF_MIN_OPEN_WAD): bigint {
  if (borrowAmount === 0n) return 0n;
  const state = stockMarketState(s);
  const debt = currentDebt(s) + borrowAmount;
  const have = s.user?.collateral ?? 0n;
  let lo = 0n;
  let hi = 10n ** 18n;
  if (healthFactorAt(state, {collateral: have, borrowed: debt}, t) >= target) return 0n;
  for (let k = 0; k < 90 && lo < hi; k++) {
    const mid = (lo + hi) / 2n;
    if (healthFactorAt(state, {collateral: have + mid, borrowed: debt}, t) >= target) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/**
 * Collateral the router requires to open (health factor ≥ 1.10 over the next 24 h, which includes any weekend or
 * earnings buffer that ramps in during that window), and how much of it is the buffer (vs the same check at the
 * current oracle price with no buffer ramp).
 */
export function collateralRequirement(s: MarketChainState, borrowAmount: bigint): {required: bigint; withoutBuffer: bigint; buffer: bigint} {
  const required = minCollateralFor(s, borrowAmount, s.now + OPEN_HORIZON_SEC);
  const withoutBuffer = minCollateralFor(s, borrowAmount, s.now);
  return {required, withoutBuffer, buffer: required > withoutBuffer ? required - withoutBuffer : 0n};
}
