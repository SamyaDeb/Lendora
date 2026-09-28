import {HF_MIN_OPEN_WAD, OPEN_HORIZON_SEC, healthFactorAt, type StockMarketState} from "@stockline/sdk";
import {currentDebt, stockMarketState, type MarketChainState} from "./chain";

/**
 * Smallest extra USDG collateral (6 dp) so the position's health factor at `t` is ≥ `target`, for a new borrow of
 * `borrowAmount` (raw stock). Binary search on the SDK health factor, like `maxBorrowFor`. Read-only: display only.
 */
export function minCollateralFor(s: MarketChainState, borrowAmount: bigint, t: bigint, target: bigint = HF_MIN_OPEN_WAD, noBuffer = false): bigint {
  if (borrowAmount === 0n) return 0n;
  const state = noBuffer ? withoutBuffer(stockMarketState(s)) : stockMarketState(s);
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

/** The same market with no weekend, earnings or guardian buffer: the baseline the buffer is measured against. */
function withoutBuffer(st: StockMarketState): StockMarketState {
  return {...st, buffer: {...st.buffer, params: {...st.buffer.params, bMin: 0n, bMax: 0n}, events: [], floor: 0n}};
}

/**
 * Collateral the router requires to open (health factor ≥ 1.10 over the next 24 h, including any weekend or
 * earnings buffer in force or ramping in during that window), and how much of it the buffer adds (vs the same check
 * with no buffer at all). During a weekend the buffer is already in force, so it shows as the difference too.
 */
export function collateralRequirement(s: MarketChainState, borrowAmount: bigint): {required: bigint; withoutBuffer: bigint; buffer: bigint} {
  const t = s.now + OPEN_HORIZON_SEC;
  const required = minCollateralFor(s, borrowAmount, t);
  const base = minCollateralFor(s, borrowAmount, t, HF_MIN_OPEN_WAD, true);
  return {required, withoutBuffer: base, buffer: required > base ? required - base : 0n};
}
