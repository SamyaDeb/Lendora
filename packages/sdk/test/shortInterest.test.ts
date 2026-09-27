import {describe, expect, it} from "vitest";
import {liquidationIncentiveFactor, toAssetsUp, toSharesDown, wTaylorCompounded} from "../src/math/morpho.js";
import {apy, aprWad, marketSupplyRate, SECONDS_PER_YEAR, vaultSupplyRate} from "../src/math/rates.js";
import {wExp} from "../src/math/irm.js";
import {marketStatusOf, shortInterestFields, type ShortInterestInputs} from "../src/shortInterest.js";

const E18 = 10n ** 18n;

const base: ShortInterestInputs = {
  market: {totalSupplyAssets: 1000n * E18, totalSupplyShares: 1000n * E18 * 10n ** 6n, totalBorrowAssets: 900n * E18, totalBorrowShares: 900n * E18 * 10n ** 6n, lastUpdate: 0n, fee: 0n},
  vaultIdle: 100n * E18,
  adapterSupplyShares: 1000n * E18 * 10n ** 6n,
  multiplier: 1_002_000_000_000_000_000n,
  stockAnswer: 225_66000000n,
  feedDecimals: 8,
  tokenTotalSupply: 90_000n * E18,
  borrowRatePerSec: 1_268_391_679n, // ≈ 4% APR
  performanceFee: 10n ** 17n,
  borrowers: 3,
  borrowed24h: 50n * E18,
  covered24h: 10n * E18,
  dexVolume: {volume: 3_000n * E18, days: 30},
  guardReasons: 0n,
  bufferWad: 0n,
  marketOpen: true,
};

describe("07 §Definitions (shortInterestFields)", () => {
  it("SI_R2 supplied = market supply + vault idle, borrowed = market borrow, both after the multiplier", () => {
    const f = shortInterestFields(base);
    expect(f.suppliedShares).toBe((1100n * E18 * base.multiplier) / E18);
    expect(f.borrowedShares).toBe((900n * E18 * base.multiplier) / E18);
    expect(f.borrowedUsd).toBe(900n * 225_66n * 10n ** 16n);
    expect(f.utilization).toBe(9n * 10n ** 17n);
    expect(f.utilizationVault).toBe((900n * E18 * E18) / (1100n * E18));
    expect(f.siPctFloat).toBe(E18 / 100n);
    expect(f.daysToCover).toBeCloseTo(9, 9);
    expect(f.newShorts24h).toBe((50n * E18 * base.multiplier) / E18);
    expect(f.priceUsd).toBe((225_66n * 10n ** 16n * E18) / base.multiplier);
  });

  it("SI_R2 supply APY is net of the performance fee and diluted by the idle reserve", () => {
    const f = shortInterestFields(base);
    const allocated = 1000n * E18; // adapter owns the whole market supply here (minus virtual-share rounding)
    const expected = vaultSupplyRate(marketSupplyRate(base.borrowRatePerSec, 9n * 10n ** 17n, 0n), allocated - 1n, 1100n * E18 - 1n, 10n ** 17n);
    expect(Number(f.supplyRatePerSec)).toBeCloseTo(Number(expected), -3);
    expect(f.supplyApy).toBeLessThan(f.borrowApy);
    expect(f.supplyApy).toBeGreaterThan(0);
  });

  it("daysToCover is null without a DEX volume source", () => {
    expect(shortInterestFields({...base, dexVolume: null}).daysToCover).toBeNull();
  });

  it("marketStatus: guard_tripped > closed > ramping > open", () => {
    expect(marketStatusOf(8n, false, 10n)).toBe("guard_tripped");
    expect(marketStatusOf(0n, false, 10n)).toBe("closed");
    expect(marketStatusOf(0n, true, 10n)).toBe("ramping");
    expect(marketStatusOf(0n, true, 0n)).toBe("open");
  });
});

describe("rates and Morpho math", () => {
  it("LM-R13 APR is rate × 365 days; APY compounds continuously", () => {
    expect(aprWad(1n)).toBe(SECONDS_PER_YEAR);
    expect(apy(0n)).toBe(0);
    expect(apy(E18 / SECONDS_PER_YEAR / 10n)).toBeCloseTo(Math.expm1(0.1), 6);
  });

  it("wExp and wTaylorCompounded are close to e^x for small x", () => {
    // ExpLib is a 2nd-order Taylor after range reduction (0.4% off at x = 1, like the Solidity it mirrors).
    expect(Math.abs(Number(wExp(E18)) / 1e18 / Math.E - 1)).toBeLessThan(0.005);
    expect(Number(wTaylorCompounded(E18 / 100n, 1n)) / 1e18).toBeCloseTo(Math.expm1(0.01), 6);
  });

  it("share conversions round like SharesMathLib (virtual shares 1e6, virtual assets 1)", () => {
    expect(toSharesDown(1n, 0n, 0n)).toBe(10n ** 6n);
    expect(toAssetsUp(1n, 0n, 0n)).toBe(1n);
  });

  it("LIF at LLTV 77% is 1.0741 (03 §2)", () => {
    expect(Number(liquidationIncentiveFactor(77n * 10n ** 16n)) / 1e18).toBeCloseTo(1.07411, 5);
    expect(liquidationIncentiveFactor(0n)).toBe(115n * 10n ** 16n);
  });
});

describe("preview rates (06)", () => {
  it("the rate at +10% utilization is higher and equals the IRM curve at that utilization", async () => {
    const {borrowRateAtUtilization} = await import("../src/math/rates.js");
    const rat = 1_268_391_679n; // ≈ 4% APR at target
    expect(borrowRateAtUtilization(9n * 10n ** 17n, rat)).toBe(rat); // at target: rate = rateAtTarget
    expect(borrowRateAtUtilization(10n ** 18n, rat)).toBe(rat * 4n); // 100%: × CURVE_STEEPNESS
    expect(borrowRateAtUtilization(5n * 10n ** 17n, rat)).toBeLessThan(rat);
  });
});
