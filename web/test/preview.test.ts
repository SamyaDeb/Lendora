import {describe, expect, it} from "vitest";
import {HF_MIN_OPEN_WAD, bufferConfigFor, healthFactorAt} from "@stockline/sdk";
import {maxBorrowFor, preview, stockMarketState} from "@/lib/preview";
import type {MarketChainState} from "@/lib/chain";

const E18 = 10n ** 18n;
const WED = 1_790_784_000n; // Wed 2026-09-30 16:00Z, feed open
const state: MarketChainState = {
  ticker: "NVDA",
  now: WED,
  block: 1n,
  stockAnswer: 225_66000000n,
  stockUpdatedAt: WED - 60n,
  usdgAnswer: 100_000_000n,
  params: {z: 25n * 10n ** 17n, sigma: 52n * 10n ** 16n, bMin: 10n ** 16n, bMax: 2n * 10n ** 17n, rampIn: 4n * 3600n},
  bufferFloor: 0n,
  bufferNow: 0n,
  guardReasons: 0n,
  multiplier: E18,
  lltv: 77n * 10n ** 16n,
  market: {totalSupplyAssets: 1000n * E18, totalSupplyShares: 1000n * E18 * 10n ** 6n, totalBorrowAssets: 100n * E18, totalBorrowShares: 100n * E18 * 10n ** 6n, lastUpdate: WED, fee: 0n},
  rateAtTarget: 1_268_391_679n,
  vaultIdle: 100n * E18,
  adapterAssets: 1000n * E18,
  perAddressCapUsd: 250_000n * E18,
  user: {address: "0x0000000000000000000000000000000000000001", collateral: 0n, borrowShares: 0n, stockBalance: 0n, usdgBalance: 10n ** 12n, vaultShares: 0n, vaultAssets: 0n, stockAllowance: 0n, usdgAllowance: 0n, vaultAllowance: 0n, authorized: false},
};

describe("06 preview panel math (all via @stockline/sdk)", () => {
  it("HF now, at the next close and at +10% equal the SDK; the close is worse than now", () => {
    const p = preview(state, {collateralIn: 20_000n * 10n ** 6n, borrowAmount: 10n * E18});
    const s = stockMarketState(state);
    const pos = {collateral: 20_000n * 10n ** 6n, borrowed: 10n * E18};
    expect(p.hfNow).toBe(healthFactorAt(s, pos, WED));
    expect(p.hfAtClose).toBe(healthFactorAt(s, pos, BigInt(p.closure!.closeTs)));
    expect(p.hfAtClose! < p.hfNow).toBe(true); // weekend buffer
    expect(p.hfPlus10 < p.hfNow).toBe(true);
    expect(p.liqPriceAtClose! < p.liqPriceNow).toBe(true);
    expect(p.borrowAprPlus10 > p.borrowAprNow).toBe(true);
    expect(p.opensOk).toBe(true);
  });

  it("RT-R1 max borrow for a target HF lands exactly on the boundary", () => {
    const coll = 5_000n * 10n ** 6n;
    const max = maxBorrowFor(state, coll, HF_MIN_OPEN_WAD);
    const s = stockMarketState(state);
    const at = (b: bigint) => healthFactorAt(s, {collateral: coll, borrowed: b}, WED + 86_400n);
    expect(at(max) >= HF_MIN_OPEN_WAD).toBe(true);
    expect(at(max + 10n ** 12n) < HF_MIN_OPEN_WAD).toBe(true);
    expect(preview(state, {collateralIn: coll, borrowAmount: max + 10n ** 15n}).opensOk).toBe(false);
  });

  it("uses the calendar config from the SDK", () => {
    expect(stockMarketState(state).buffer.sessions).toBe(bufferConfigFor("NVDA", state.params).sessions);
  });
});
