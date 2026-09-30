import type {Session} from "../calendar/sessions.js";
import {mulDivDown, WAD} from "./wad.js";

/**
 * Oracle, buffer and health-factor math (docs/prd/04-oracle.md). Mirrors `contracts/src/libraries/OracleMath.sol` and
 * `LendoraOracleBase.bufferAt` operation for operation (floor at each step), so results match exactly (OR-R1, OR-R22).
 * All amounts are bigint in raw units; timestamps are bigint UTC seconds.
 */

export const YEAR = 8760n * 3600n;
export const ORACLE_PRICE_SCALE = 10n ** 36n;
export const MAX_CLOSURE = 96n * 3600n;
export const MAX_BUFFER = 2n * 10n ** 17n;

/** Floor square root, identical to OpenZeppelin `Math.sqrt`. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

/** `clamp(z·σ·sqrt(closureSeconds / YEAR), bMin, bMax)`, WAD (OracleMath.fullBuffer). */
export function fullBuffer(z: bigint, sigma: bigint, bMin: bigint, bMax: bigint, closureSeconds: bigint): bigint {
  const s = isqrt((closureSeconds * 10n ** 36n) / YEAR);
  let b = mulDivDown(mulDivDown(z, sigma, WAD), s, WAD);
  if (b < bMin) b = bMin;
  if (b > bMax) b = bMax;
  return b;
}

/** One window's buffer: ramp over `ramp` before `start`, hold, release on the first round ≥ `releaseAt` (0 = never). */
export function windowBuffer(bFull: bigint, start: bigint, releaseAt: bigint, ramp: bigint, t: bigint, updatedAt: bigint): bigint {
  if (releaseAt !== 0n && updatedAt >= releaseAt) return 0n;
  if (t >= start) return bFull;
  if (t + ramp <= start) return 0n;
  return mulDivDown(bFull, t + ramp - start, ramp);
}

/** Stock-loan market price (OracleMath.stockLoanPrice, D1: the feed already includes the multiplier). */
export function stockLoanPrice(valuePerToken: bigint, usdgAnswer: bigint, stockAnswer: bigint, buffer: bigint, scaleExp: bigint): bigint {
  return mulDivDown(valuePerToken * usdgAnswer, 10n ** scaleExp, stockAnswer * (WAD + buffer));
}

/** Receipt-collateral market price (OracleMath.receiptPrice). */
export function receiptPrice(assetsPerShare: bigint, stockAnswer: bigint, usdgAnswer: bigint, buffer: bigint, scaleExp: bigint): bigint {
  return mulDivDown(assetsPerShare * stockAnswer, (WAD - buffer) * 10n ** scaleExp, WAD * usdgAnswer);
}

/** Morpho health factor, WAD (OracleMath.healthFactor). `MAX_UINT256` when nothing is borrowed. */
export function healthFactor(collateral: bigint, price: bigint, lltv: bigint, borrowed: bigint): bigint {
  if (borrowed === 0n) return 2n ** 256n - 1n;
  const maxBorrow = mulDivDown(mulDivDown(collateral, price, ORACLE_PRICE_SCALE), lltv, WAD);
  return mulDivDown(maxBorrow, WAD, borrowed);
}

// ---------------------------------------------------------------------- calendar-level buffer (OR-R20)

export interface BufferParams {
  z: bigint;
  sigma: bigint;
  bMin: bigint;
  bMax: bigint;
  rampIn: bigint;
}

export interface EventWindowBig {
  startTs: bigint;
  endTs: bigint;
  bufferWad: bigint;
}

export interface BufferConfig {
  params: BufferParams;
  sessions: Session[];
  /** Event windows of this stock, ordered by start. */
  events: EventWindowBig[];
  /** Guardian floor (WAD). */
  floor: bigint;
}

/** MarketHours.closureWindows. */
export function closureWindows(sessions: Session[], t: bigint): [bigint, bigint, bigint, bigint] {
  let lo = 0;
  let hi = sessions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (BigInt(sessions[mid].closeTs) <= t) lo = mid + 1;
    else hi = mid;
  }
  const k = lo;
  const prevClose = k > 0 ? BigInt(sessions[k - 1].closeTs) : 0n;
  const prevReopen = k < sessions.length ? BigInt(sessions[k].openTs) : 0n;
  const nextClose = k < sessions.length ? BigInt(sessions[k].closeTs) : 0n;
  const nextReopen = k + 1 < sessions.length ? BigInt(sessions[k + 1].openTs) : 0n;
  return [prevClose, prevReopen, nextClose, nextReopen];
}

/** MarketHours.eventWindows: the latest event with startTs ≤ x and the one before it. */
export function eventWindowsAt(events: EventWindowBig[], x: bigint): [EventWindowBig | undefined, EventWindowBig | undefined] {
  let k = 0;
  while (k < events.length && events[k].startTs <= x) k++;
  return [k > 0 ? events[k - 1] : undefined, k > 1 ? events[k - 2] : undefined];
}

function closureWindow(p: BufferParams, close: bigint, reopen: bigint, t: bigint, u: bigint): bigint {
  const len = close === 0n || reopen === 0n ? MAX_CLOSURE : reopen - close;
  return windowBuffer(fullBuffer(p.z, p.sigma, p.bMin, p.bMax, len), close, reopen, p.rampIn, t, u);
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** LendoraOracleBase.bufferAt(t, lastGoodUpdatedAt). */
export function bufferAt(cfg: BufferConfig, t: bigint, lastGoodUpdatedAt: bigint): bigint {
  const p = cfg.params;
  const [prevClose, prevReopen, nextClose, nextReopen] = closureWindows(cfg.sessions, t);
  let b = max(cfg.floor, closureWindow(p, prevClose, prevReopen, t, lastGoodUpdatedAt));
  if (nextClose !== 0n) b = max(b, closureWindow(p, nextClose, nextReopen, t, lastGoodUpdatedAt));
  for (const e of eventWindowsAt(cfg.events, t + p.rampIn)) {
    if (!e) continue;
    const full = e.bufferWad > p.bMax ? p.bMax : e.bufferWad;
    b = max(b, windowBuffer(full, e.startTs, e.endTs, p.rampIn, t, lastGoodUpdatedAt));
  }
  return b > p.bMax ? p.bMax : b;
}

// ---------------------------------------------------------------------- position views (OR-R22)

export interface StockMarketState {
  buffer: BufferConfig;
  /** Stock feed answer in use (raw feed decimals) and its updatedAt. */
  stockAnswer: bigint;
  stockUpdatedAt: bigint;
  usdgAnswer: bigint;
  valuePerToken: bigint;
  /** `36 + loanDec − collDec + stockFeedDec − usdgFeedDec`, 48 for the launch markets. */
  scaleExp: bigint;
  lltv: bigint;
}

export interface Position {
  /** `clUSDG` collateral, raw units. */
  collateral: bigint;
  /** Debt in `wSTOCK` assets, raw units. */
  borrowed: bigint;
}

/** Morpho price with the buffer at `t` and no new feed rounds (LendoraOracle.priceAt). */
export function priceAt(s: StockMarketState, t: bigint): bigint {
  return stockLoanPrice(s.valuePerToken, s.usdgAnswer, s.stockAnswer, bufferAt(s.buffer, t, s.stockUpdatedAt), s.scaleExp);
}

/** Health factor (WAD) at `t` at today's feed price (e.g. "after Friday's ramp-in"). */
export function healthFactorAt(s: StockMarketState, pos: Position, t: bigint): bigint {
  return healthFactor(pos.collateral, priceAt(s, t), s.lltv, pos.borrowed);
}

/**
 * Stock feed answer (raw feed decimals) above which the position becomes liquidatable at `t`, given the buffer then:
 * `collateral·vpt·usdg·10^scaleExp·lltv / (1e36·1e18·borrowed·(1e18 + b))`, floored. Display only (not onchain).
 */
export function liquidationPriceAt(s: StockMarketState, pos: Position, t: bigint): bigint {
  return liquidationPrice(pos, bufferAt(s.buffer, t, s.stockUpdatedAt), s.valuePerToken, s.usdgAnswer, s.lltv, s.scaleExp);
}

/** Stock feed answer (raw feed decimals) above which `pos` is liquidatable with buffer `b` in force. 0 = no debt. */
export function liquidationPrice(pos: Position, b: bigint, valuePerToken: bigint, usdgAnswer: bigint, lltv: bigint, scaleExp: bigint): bigint {
  if (pos.borrowed === 0n) return 0n;
  const num = pos.collateral * valuePerToken * usdgAnswer * 10n ** scaleExp * lltv;
  return num / (ORACLE_PRICE_SCALE * WAD * pos.borrowed * (WAD + b));
}
