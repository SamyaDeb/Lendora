import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {generateSessions} from "../src/calendar/sessions.js";
import {etToUnix, parseYmd} from "../src/calendar/time.js";
import {
  bufferAt,
  closureWindows,
  fullBuffer,
  healthFactor,
  healthFactorAt,
  isqrt,
  liquidationPriceAt,
  priceAt,
  stockLoanPrice,
  windowBuffer,
  type StockMarketState,
} from "../src/math/oracle.js";

const E18 = 10n ** 18n;
const H = 3600n;
const NVDA = {z: 25n * 10n ** 17n, sigma: 52n * 10n ** 16n, bMin: 10n ** 16n, bMax: 2n * 10n ** 17n, rampIn: 4n * H};
const sessions = generateSessions(parseYmd("2026-06-22"), parseYmd("2027-12-31"));
const et = (d: string, h: number) => BigInt(etToUnix(parseYmd(d), h));

describe("math primitives (mirror OracleMath.sol)", () => {
  it("isqrt is the floor square root", () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 36n, 10n ** 36n - 1n, 2n ** 255n]) {
      const r = isqrt(n);
      expect(r * r <= n && (r + 1n) * (r + 1n) > n).toBe(true);
    }
    expect(() => isqrt(-1n)).toThrow();
  });

  it("b_full matches the 10-risk launch table (σ 5y, z 2.5)", () => {
    const pct = (b: bigint) => Number(b) / 1e16;
    expect(pct(fullBuffer(NVDA.z, 52n * 10n ** 16n, NVDA.bMin, NVDA.bMax, 48n * H))).toBeCloseTo(9.6, 1);
    expect(pct(fullBuffer(NVDA.z, 17n * 10n ** 16n, NVDA.bMin, NVDA.bMax, 48n * H))).toBeCloseTo(3.1, 1);
    expect(pct(fullBuffer(NVDA.z, 28n * 10n ** 16n, NVDA.bMin, NVDA.bMax, 72n * H))).toBeCloseTo(6.35, 2);
    expect(fullBuffer(NVDA.z, 52n * 10n ** 16n, NVDA.bMin, NVDA.bMax, 1n)).toBe(NVDA.bMin);
    expect(fullBuffer(4n * E18, 15n * 10n ** 17n, 0n, NVDA.bMax, 400n * H)).toBe(NVDA.bMax);
  });

  it("windowBuffer ramps, holds and releases only on a fresh round", () => {
    const b = 10n ** 17n;
    expect(windowBuffer(b, 1000n * H, 1048n * H, 4n * H, 996n * H, 0n)).toBe(0n);
    expect(windowBuffer(b, 1000n * H, 1048n * H, 4n * H, 998n * H, 0n)).toBe(b / 2n);
    expect(windowBuffer(b, 1000n * H, 1048n * H, 4n * H, 1060n * H, 1047n * H)).toBe(b);
    expect(windowBuffer(b, 1000n * H, 1048n * H, 4n * H, 1060n * H, 1048n * H)).toBe(0n);
    expect(windowBuffer(b, 1000n * H, 0n, 4n * H, 5000n * H, 4999n * H)).toBe(b);
  });

  it("price: $100 NVDA, $1 USDG, no buffer is 1e46 (D1: no multiplier input exists)", () => {
    expect(stockLoanPrice(E18, 10n ** 8n, 100n * 10n ** 8n, 0n, 48n)).toBe(10n ** 46n);
  });

  it("health factor is MAX with no debt and 1.0 at the limit", () => {
    expect(healthFactor(1n, 1n, 1n, 0n)).toBe(2n ** 256n - 1n);
    // 1500 USDG, price 1e46 (0.01 wNVDA per clUSDG), LLTV 77% → max borrow 11.55 wNVDA
    expect(healthFactor(1500n * 10n ** 6n, 10n ** 46n, 77n * 10n ** 16n, 1155n * 10n ** 16n)).toBe(E18);
  });
});

describe("bufferAt on the real feed calendar (OR-R20, OR-R23)", () => {
  const cfg = {params: NVDA, sessions, events: [], floor: 0n};

  it("closureWindows mirrors MarketHours", () => {
    const [pc, pr, nc, nr] = closureWindows(sessions, et("2026-09-19", 12));
    expect([pc, pr, nc, nr]).toEqual([et("2026-09-18", 20), et("2026-09-20", 20), et("2026-09-25", 20), et("2026-09-27", 20)]);
    expect(closureWindows([], 1n)).toEqual([0n, 0n, 0n, 0n]);
  });

  it("Friday ramp → weekend hold → released by the first Sunday round", () => {
    const u = et("2026-09-16", 12);
    const b48 = fullBuffer(NVDA.z, NVDA.sigma, NVDA.bMin, NVDA.bMax, 48n * H);
    expect(bufferAt(cfg, et("2026-09-18", 16), u)).toBe(0n);
    expect(bufferAt(cfg, et("2026-09-18", 18), u)).toBe(b48 / 2n);
    expect(bufferAt(cfg, et("2026-09-19", 12), u)).toBe(b48);
    expect(bufferAt(cfg, et("2026-09-20", 23), u)).toBe(b48);
    expect(bufferAt(cfg, et("2026-09-20", 23), et("2026-09-20", 20) + 30n)).toBe(0n);
  });

  it("events take the max with closures and are capped at bMax", () => {
    const end = et("2026-09-17", 16);
    const ev = {...cfg, events: [{startTs: end - H, endTs: end, bufferWad: 3n * 10n ** 17n}]};
    expect(bufferAt(ev, end, end - 1n)).toBe(NVDA.bMax);
    expect(bufferAt({...cfg, floor: 5n * 10n ** 16n}, et("2026-09-16", 12), et("2026-09-16", 12))).toBe(5n * 10n ** 16n);
  });
});

describe("position views (OR-R22)", () => {
  const state: StockMarketState = {
    buffer: {params: NVDA, sessions, events: [], floor: 0n},
    stockAnswer: 100n * 10n ** 8n,
    stockUpdatedAt: et("2026-09-16", 12),
    usdgAnswer: 10n ** 8n,
    valuePerToken: E18,
    scaleExp: 48n,
    lltv: 77n * 10n ** 16n,
  };
  const pos = {collateral: 1500n * 10n ** 6n, borrowed: 10n * E18};

  it("Priya's example: liquidation above $115.50, about $105.4 with the weekend buffer", () => {
    expect(liquidationPriceAt(state, pos, et("2026-09-16", 12))).toBe(11_550_000_000n); // $115.50 at 8 dp
    const weekend = liquidationPriceAt(state, pos, et("2026-09-19", 12));
    expect(Number(weekend) / 1e8).toBeCloseTo(115.5 / 1.0962, 1);
    expect(liquidationPriceAt(state, {collateral: 1n, borrowed: 0n}, 0n)).toBe(0n);
  });

  it("health factor falls when the weekend buffer ramps in, at today's feed price", () => {
    const hfWed = healthFactorAt(state, pos, et("2026-09-16", 12));
    const hfSat = healthFactorAt(state, pos, et("2026-09-19", 12));
    expect(hfWed).toBe((1155n * E18) / 1000n);
    expect(hfSat < hfWed).toBe(true);
    expect(priceAt(state, et("2026-09-16", 12))).toBe(10n ** 46n);
  });

  it("at the liquidation price the position is exactly at (or just above) HF 1", () => {
    const t = et("2026-09-19", 12);
    const pLiq = liquidationPriceAt(state, pos, t);
    const at = healthFactorAt({...state, stockAnswer: pLiq}, pos, t);
    const above = healthFactorAt({...state, stockAnswer: pLiq + 2n}, pos, t);
    expect(at >= E18).toBe(true);
    expect(above < E18).toBe(true);
  });
});

describe("shared vectors are reproducible", () => {
  it("regenerating gives byte-identical files", () => {
    const dir = new URL("../../../contracts/test/vectors/", import.meta.url);
    const before = ["buffer.json", "price.json", "health.json"].map((f) => readFileSync(new URL(f, dir), "utf8"));
    execFileSync("npx", ["tsx", "scripts/genVectors.ts"], {cwd: new URL("..", import.meta.url), stdio: "ignore"});
    const after = ["buffer.json", "price.json", "health.json"].map((f) => readFileSync(new URL(f, dir), "utf8"));
    expect(after).toEqual(before);
  }, 60_000);
});
