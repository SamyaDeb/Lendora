import {describe, expect, it} from "vitest";
import {allocationRoom, freeLiquidity, planAllocation, type AllocatorState} from "../src/math/allocator.js";

const E18 = 10n ** 18n;
const P = {uMax: 9n * 10n ** 17n, minMove: 10n ** 12n};
const base: AllocatorState = {
  totalAssets: 1000n * E18,
  idle: 1000n * E18,
  allocation: 0n,
  absoluteCap: 10_000n * E18,
  relativeCap: 9n * 10n ** 17n,
  adapterAssets: 0n,
  marketSupply: 10n ** 12n,
  marketBorrow: 0n,
  pull: false,
};

describe("allocator plan (LM-R30, LM-R31, LM-R34)", () => {
  it("allocates everything above the 10% idle reserve, bounded by the relative cap", () => {
    expect(planAllocation(base, P)).toEqual({kind: "allocate", assets: 900n * E18, reason: "idle above reserve"});
  });

  it("respects the absolute cap", () => {
    expect(planAllocation({...base, absoluteCap: 100n * E18}, P)).toMatchObject({kind: "allocate", assets: 100n * E18});
  });

  it("restores the idle reserve after withdrawals, from free liquidity only", () => {
    const s = {...base, totalAssets: 500n * E18, idle: 10n * E18, allocation: 490n * E18, adapterAssets: 490n * E18, marketSupply: 490n * E18, marketBorrow: 470n * E18};
    expect(planAllocation(s, P)).toEqual({kind: "deallocate", assets: 20n * E18, reason: "restore idle reserve"});
  });

  it("pulls all free liquidity when tripped", () => {
    const s = {...base, idle: 100n * E18, allocation: 900n * E18, adapterAssets: 900n * E18, marketSupply: 900n * E18, marketBorrow: 600n * E18, pull: true};
    expect(planAllocation(s, P)).toEqual({kind: "deallocate", assets: 300n * E18, reason: "pull: guard tripped or event window"});
    expect(planAllocation({...s, marketBorrow: 900n * E18}, P).kind).toBe("none");
  });

  it("does nothing inside the band", () => {
    expect(planAllocation({...base, idle: 100n * E18, allocation: 900n * E18}, P).kind).toBe("none");
  });

  it("fuzz: never deallocates more than free liquidity or allocates beyond the caps (LM-R34)", () => {
    let x = 0x1234_5678n;
    const r = (max: bigint) => {
      x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return max === 0n ? 0n : x % (max + 1n);
    };
    for (let i = 0; i < 20_000; i++) {
      const totalAssets = r(10_000n * E18);
      const allocation = r(totalAssets);
      const adapterAssets = allocation + r(E18);
      const marketSupply = adapterAssets + r(100n * E18);
      const s: AllocatorState = {
        totalAssets,
        idle: totalAssets - allocation,
        allocation,
        absoluteCap: r(20_000n * E18),
        relativeCap: r(E18),
        adapterAssets,
        marketSupply,
        marketBorrow: r(marketSupply + E18),
        pull: r(3n) === 0n,
      };
      const a = planAllocation(s, P);
      if (a.kind === "deallocate") {
        expect(a.assets <= freeLiquidity(s)).toBe(true);
        expect(a.assets <= s.adapterAssets).toBe(true);
      }
      if (a.kind === "allocate") {
        expect(a.assets <= allocationRoom(s)).toBe(true);
        expect(a.assets <= s.idle).toBe(true);
        expect(s.pull).toBe(false);
      }
    }
  });
});
