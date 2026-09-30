import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {morphoAbi} from "@lendora/sdk";
import {startAnvil, type Anvil} from "../src/anvil.js";
import {ChainDriver} from "../src/driver.js";
import {smokeFlows} from "../src/smoke.js";

/** The testnet smoke sequence (Phase 2 task 7), proven on anvil: every router flow, ending flat. */
describe("smoke flows", () => {
  let a: Anvil;
  beforeAll(async () => {
    a = await startAnvil();
  });
  afterAll(() => a?.stop());

  it("runs lend, openShort, addCollateral, repay, closeShort, borrow, repay all, withdrawCollateral, withdrawLend", async () => {
    const drv = new ChainDriver(a);
    await drv.freshRounds(1_790_784_000n);
    const me = "0x57000000000000000000000000000000000000f1" as const;
    const events = await smokeFlows(drv, me, () => {});
    expect(events.map((e) => e.kind)).toEqual(["lend", "lend", "allocate", "allocate", "openShort", "addCollateral", "repay", "closeShort", "borrow", "repay", "withdrawCollateral", "withdrawLend", "withdrawLend"]);
    for (const t of ["NVDA", "AAPL"]) {
      const pos = await a.client.readContract({address: a.d.morpho, abi: morphoAbi, functionName: "position", args: [a.d.stocks[t].marketId, me]});
      expect(pos.borrowShares, t).toBe(0n);
      expect(pos.collateral, t).toBe(0n);
    }
  });
});
