/**
 * Morpho AdaptiveCurveIrm (`morpho-blue-irm`, the IRM enabled on Robinhood Chain and pinned in `contracts/lib`),
 * mirrored exactly in signed WAD arithmetic: `_borrowRate`, `_curve`, `_newRateAtTarget` and `ExpLib.wExp`. JS bigint
 * division truncates toward zero like Solidity's signed division. Vectors: `contracts/test/vectors/irm.json`.
 */

const WAD = 10n ** 18n;
const YEAR = 365n * 86_400n;

export const CURVE_STEEPNESS = 4n * WAD;
export const ADJUSTMENT_SPEED = (50n * WAD) / YEAR;
export const TARGET_UTILIZATION = 9n * 10n ** 17n;
export const INITIAL_RATE_AT_TARGET = (4n * 10n ** 16n) / YEAR;
export const MIN_RATE_AT_TARGET = (10n ** 15n) / YEAR;
export const MAX_RATE_AT_TARGET = (2n * WAD) / YEAR;

const LN_2_INT = 693_147_180_559_945_309n;
const LN_WEI_INT = -41_446_531_673_892_822_312n;
const WEXP_UPPER_BOUND = 93_859_467_695_000_404_319n;
const WEXP_UPPER_VALUE = 57_716_089_161_558_943_949_701_069_502_944_508_345_128_422_502_756_744_429_568n;

const wMulToZero = (x: bigint, y: bigint) => (x * y) / WAD;
const wDivToZero = (x: bigint, y: bigint) => (x * WAD) / y;
const bound = (x: bigint, lo: bigint, hi: bigint) => (x < lo ? lo : x > hi ? hi : x);

/** `ExpLib.wExp`: e^x in WAD for signed WAD x (second-order Taylor after range reduction by ln 2). */
export function wExp(x: bigint): bigint {
  if (x < LN_WEI_INT) return 0n;
  if (x >= WEXP_UPPER_BOUND) return WEXP_UPPER_VALUE;
  const roundingAdjustment = x < 0n ? -(LN_2_INT / 2n) : LN_2_INT / 2n;
  const q = (x + roundingAdjustment) / LN_2_INT;
  const r = x - q * LN_2_INT;
  const expR = WAD + r + (r * r) / WAD / 2n;
  return q >= 0n ? expR << q : expR >> -q;
}

function curve(rateAtTarget: bigint, err: bigint): bigint {
  const coeff = err < 0n ? WAD - wDivToZero(WAD, CURVE_STEEPNESS) : CURVE_STEEPNESS - WAD;
  return wMulToZero(wMulToZero(coeff, err) + WAD, rateAtTarget);
}

function newRateAtTarget(start: bigint, linearAdaptation: bigint): bigint {
  return bound(wMulToZero(start, wExp(linearAdaptation)), MIN_RATE_AT_TARGET, MAX_RATE_AT_TARGET);
}

export interface IrmMarketState {
  totalSupplyAssets: bigint;
  totalBorrowAssets: bigint;
  lastUpdate: bigint;
}

/**
 * `AdaptiveCurveIrm._borrowRate(id, market)` at `now`: `avgRate` is what `borrowRateView` returns (per second, WAD)
 * and what Morpho accrues with; `endRateAtTarget` is what `borrowRate` would store.
 */
export function adaptiveCurveBorrowRate(m: IrmMarketState, rateAtTarget: bigint, now: bigint): {avgRate: bigint; endRateAtTarget: bigint} {
  const u = m.totalSupplyAssets > 0n ? (m.totalBorrowAssets * WAD) / m.totalSupplyAssets : 0n;
  const errNormFactor = u > TARGET_UTILIZATION ? WAD - TARGET_UTILIZATION : TARGET_UTILIZATION;
  const err = wDivToZero(u - TARGET_UTILIZATION, errNormFactor);
  let avg: bigint;
  let end: bigint;
  if (rateAtTarget === 0n) {
    avg = INITIAL_RATE_AT_TARGET;
    end = INITIAL_RATE_AT_TARGET;
  } else {
    const speed = wMulToZero(ADJUSTMENT_SPEED, err);
    const elapsed = now - m.lastUpdate;
    const linearAdaptation = speed * elapsed;
    if (linearAdaptation === 0n) {
      avg = rateAtTarget;
      end = rateAtTarget;
    } else {
      end = newRateAtTarget(rateAtTarget, linearAdaptation);
      const mid = newRateAtTarget(rateAtTarget, linearAdaptation / 2n);
      avg = (rateAtTarget + end + 2n * mid) / 4n;
    }
  }
  return {avgRate: curve(avg, err), endRateAtTarget: end};
}
