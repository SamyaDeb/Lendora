import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {morphoAbi, stocklineOracleAbi} from "@stockline/sdk";
import {startAnvil, type Anvil} from "../src/anvil.js";
import {ChainDriver} from "../src/driver.js";
import {seedWeek, USERS, type SeedResult} from "../src/scenario.js";

describe("chain driver seed week on anvil (Phase 2 task 0)", () => {
  let a: Anvil;
  let drv: ChainDriver;
  let r: SeedResult;

  beforeAll(async () => {
    a = await startAnvil();
    drv = new ChainDriver(a);
    r = await seedWeek(drv);
  });
  afterAll(() => a?.stop());

  const kinds = () => r.events.map((e) => e.kind);

  it("runs every router flow of 05 §4 plus a standard liquidation", () => {
    for (const k of ["lend", "withdrawLend", "borrow", "openShort", "closeShort", "repay", "addCollateral", "liquidate", "allocate", "deallocate"]) {
      expect(kinds(), k).toContain(k);
    }
  });

  it("RT-R8: a debt-free address cannot add collateral (rescue top-up only), with a decoded revert", async () => {
    const fresh = "0x00000000000000000000000000000000000fee01" as const;
    await expect(drv.addCollateral("NVDA", fresh, 1_000n * 10n ** 6n)).rejects.toThrow(/NoDebtPosition/);
  });

  it("crosses a weekend: the buffer ramps in before the Friday close and is released by the Monday round", async () => {
    const t = r.times;
    expect(await drv.isOpen(t.rampStart + 3600n)).toBe(true);
    expect(await drv.isOpen(t.close + 3600n)).toBe(false);
    const nvda = drv.stock("NVDA");
    const [, u] = await a.client.readContract({address: nvda.oracle, abi: stocklineOracleAbi, functionName: "stockAnswer"});
    const bufAtClose = await a.client.readContract({address: nvda.oracle, abi: stocklineOracleAbi, functionName: "bufferAt", args: [t.close, t.close - 600n]});
    expect(bufAtClose > 9n * 10n ** 16n).toBe(true); // NVDA 48h b_full ≈ 9.6%
    expect(await a.client.readContract({address: nvda.oracle, abi: stocklineOracleAbi, functionName: "bufferAt", args: [t.reopen + 120n, u]})).toBe(0n);
  });

  it("the Monday gap made Erin liquidatable and a standard Morpho liquidation left her healthy", async () => {
    const liq = r.events.find((e) => e.kind === "liquidate")!;
    expect(liq.user).toBe(USERS.erin);
    expect(liq.timestamp > r.times.reopen).toBe(true);
    const pos = await a.client.readContract({address: a.d.morpho, abi: morphoAbi, functionName: "position", args: [drv.stock("NVDA").marketId, USERS.erin]});
    expect(pos.borrowShares > 0n).toBe(true);
    expect((await drv.healthFactor("NVDA", USERS.erin)) > 10n ** 18n).toBe(true);
  });

  it("the AAPL guard trip pulled liquidity and rejected a borrow; exits still worked; it cleared (LM-R31, CP-R4)", async () => {
    expect(kinds()).toContain("borrowRejected");
    expect(kinds()).toContain("issuerPause");
    const pause = r.events.findIndex((e) => e.kind === "guardian:trip");
    const repayAfter = r.events.findIndex((e, i) => i > pause && e.kind === "repay" && e.ticker === "AAPL");
    expect(repayAfter).toBeGreaterThan(pause);
    expect(r.events.some((e, i) => i > pause && e.kind === "deallocate" && e.ticker === "AAPL")).toBe(true);
    expect(await a.client.readContract({address: drv.stock("AAPL").oracle, abi: stocklineOracleAbi, functionName: "guardTripped"})).toBe(false);
  });

  it("closed positions are flat: Frank (closeShort) and Grace (repay all) owe nothing", async () => {
    for (const [t, u] of [["SPY", USERS.frank], ["AAPL", USERS.grace]] as const) {
      const pos = await a.client.readContract({address: a.d.morpho, abi: morphoAbi, functionName: "position", args: [drv.stock(t).marketId, u]});
      expect(pos.borrowShares, `${t} borrowShares`).toBe(0n);
    }
  });
});
