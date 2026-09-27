import {
  HF_MIN_OPEN_WAD,
  OPEN_HORIZON_SEC,
  WAD,
  adaptiveCurveBorrowRate,
  apy,
  aprWad,
  borrowRateAtUtilization,
  expectedMarketBalances,
  healthFactorAt,
  liquidationPriceAt,
  nextClosure,
  nextEvent,
  utilization,
  utilizationPlus,
} from "@stockline/sdk";
import {currentDebt, stockMarketState, type MarketChainState} from "./chain";

/**
 * The Borrow/Short preview panel (06 §Preview panel), computed only with @stockline/sdk from chain state, so it
 * matches the contracts (the e2e test compares it with the onchain result, 06 acceptance).
 */
export interface PreviewInput {
  /** USDG added as collateral (6 dp). */
  collateralIn: bigint;
  /** Stock borrowed (raw, 18 dp). */
  borrowAmount: bigint;
  /** openShort: sale proceeds quoted by the DEX (6 dp) and whether they are compounded into collateral. */
  usdgOut?: bigint;
  compound?: boolean;
  slippageBps?: bigint;
}

export interface Preview {
  collateral: bigint;
  borrowed: bigint;
  borrowedUsd: number;
  borrowAprNow: bigint;
  borrowAprPlus10: bigint;
  borrowApyNow: number;
  hfNow: bigint;
  hfAtClose?: bigint;
  hfPlus10: bigint;
  /** RT-R1: HF at now + 24h, the router's opening check. */
  hfHorizon: bigint;
  opensOk: boolean;
  liqPriceNow: bigint;
  liqPriceAtClose?: bigint;
  closure?: {rampStartTs: number; closeTs: number; reopenTs: number; bufferAtClose: bigint; open: boolean};
  event?: {startTs: bigint; endTs: bigint; bufferWad: bigint};
  swap?: {usdgOut: bigint; minOut: bigint; priceImpact: number};
  multiplier: bigint;
}

export {stockMarketState, currentDebt};

export function preview(s: MarketChainState, i: PreviewInput): Preview {
  const state = stockMarketState(s);
  const slip = i.slippageBps ?? 100n;
  const minOut = i.usdgOut !== undefined ? (i.usdgOut * (10_000n - slip)) / 10_000n : undefined;
  const compoundAdd = i.compound && minOut !== undefined ? minOut : 0n;
  const collateral = (s.user?.collateral ?? 0n) + i.collateralIn + compoundAdd;
  const borrowed = currentDebt(s) + i.borrowAmount;
  const pos = {collateral, borrowed};

  const accrued = expectedMarketBalances(s.market, s.rateAtTarget, s.now);
  const after = {...accrued, totalBorrowAssets: accrued.totalBorrowAssets + i.borrowAmount};
  const rateNow = adaptiveCurveBorrowRate({...after, lastUpdate: s.now}, s.rateAtTarget, s.now).avgRate;
  const uPlus = utilizationPlus(utilization(after), 10n ** 17n);
  const ratePlus = borrowRateAtUtilization(uPlus, s.rateAtTarget === 0n ? 1_268_391_679n : s.rateAtTarget);

  const nc = nextClosure(Number(s.now), s.params);
  const ev = nextEvent(s.ticker, Number(s.now));
  const hfHorizon = healthFactorAt(state, pos, s.now + OPEN_HORIZON_SEC);
  const plus10 = {...state, stockAnswer: (s.stockAnswer * 11n) / 10n};
  const feedValue = (i.borrowAmount * s.stockAnswer) / 10n ** 20n; // USDG 6 dp at the feed price
  return {
    collateral,
    borrowed,
    borrowedUsd: Number((borrowed * s.stockAnswer) / 10n ** 8n) / 1e18,
    borrowAprNow: aprWad(rateNow),
    borrowAprPlus10: aprWad(ratePlus),
    borrowApyNow: apy(rateNow),
    hfNow: healthFactorAt(state, pos, s.now),
    hfAtClose: nc ? healthFactorAt(state, pos, BigInt(nc.closeTs)) : undefined,
    hfPlus10: healthFactorAt(plus10, pos, s.now),
    hfHorizon,
    opensOk: borrowed === 0n || hfHorizon >= HF_MIN_OPEN_WAD,
    liqPriceNow: liquidationPriceAt(state, pos, s.now),
    liqPriceAtClose: nc ? liquidationPriceAt(state, pos, BigInt(nc.closeTs)) : undefined,
    closure: nc ? {rampStartTs: nc.rampStartTs, closeTs: nc.closeTs, reopenTs: nc.reopenTs, bufferAtClose: nc.bufferAtClose, open: nc.open} : undefined,
    event: ev,
    swap:
      i.usdgOut !== undefined && minOut !== undefined
        ? {usdgOut: i.usdgOut, minOut, priceImpact: feedValue > 0n ? Number(feedValue - i.usdgOut) / Number(feedValue) : 0}
        : undefined,
    multiplier: s.multiplier,
  };
}

/** Largest borrow (raw stock) with HF at the RT-R1 horizon ≥ `targetHf` for the given collateral (binary search on
 * the SDK health factor), for the "target LTV" slider. */
export function maxBorrowFor(s: MarketChainState, collateralIn: bigint, targetHf: bigint = HF_MIN_OPEN_WAD): bigint {
  const state = stockMarketState(s);
  const debt = currentDebt(s);
  const collateral = (s.user?.collateral ?? 0n) + collateralIn;
  let lo = 0n;
  let hi = 10n ** 30n;
  for (let k = 0; k < 120 && lo < hi; k++) {
    const mid = (lo + hi + 1n) / 2n;
    if (healthFactorAt(state, {collateral, borrowed: debt + mid}, s.now + OPEN_HORIZON_SEC) >= targetHf) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

export const ONE = WAD;
