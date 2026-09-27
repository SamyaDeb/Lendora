import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {erc20Abi, marketHoursAbi, morphoAbi, stocklineOracleAbi, vaultV2Abi} from "@stockline/sdk";
import {startAnvil, type Anvil} from "./anvil.js";
import {allocation, call, freshRounds, lend, WED} from "./helpers.js";
import {Allocator} from "../src/allocator/allocator.js";
import {DryRunSender, rpcUnlockedSender} from "../src/common/signer.js";
import {Health} from "../src/common/health.js";
import {anvil as anvilChain} from "viem/chains";

describe("allocator keeper on anvil with the task-7 deployment (LM-R30…R34, D5)", () => {
  let a: Anvil;
  let allocator: Allocator;
  let health: Health;
  const lender = "0x00000000000000000000000000000000000000a1" as const;

  beforeAll(async () => {
    a = await startAnvil();
    await freshRounds(a, WED);
    await lend(a, "NVDA", lender, 100n * 10n ** 18n);
    await a.test.impersonateAccount({address: a.d.roles.allocator});
    health = new Health(5 * 60_000);
    allocator = new Allocator(a.client, rpcUnlockedSender(a.client, a.url, anvilChain, a.d.roles.allocator), a.d, undefined, health, () => {});
  });
  afterAll(() => a?.stop());

  it("dry run plans but sends nothing", async () => {
    const dry = new DryRunSender(a.d.roles.allocator, () => {});
    const plan = await new Allocator(a.client, dry, a.d, undefined, undefined, () => {}).tick();
    expect(plan.NVDA.kind).toBe("allocate");
    expect(dry.sent).toHaveLength(1);
    expect(await allocation(a, "NVDA")).toBe(0n);
  });

  it("LM-R30: allocates down to the 10% idle reserve, then is idempotent", async () => {
    const actions = await allocator.tick();
    expect(actions.NVDA.kind).toBe("allocate");
    const s = a.d.stocks.NVDA;
    const total = await a.client.readContract({address: s.vault, abi: vaultV2Abi, functionName: "totalAssets"});
    const idle = await a.client.readContract({address: s.wrapper, abi: erc20Abi, functionName: "balanceOf", args: [s.vault]});
    expect(idle * 10n >= total - 10n ** 15n * 10n && idle * 10n <= total + 10n ** 15n * 10n).toBe(true);
    expect((await allocator.tick()).NVDA.kind).toBe("none");
    expect(health.report().healthy).toBe(true);
    expect(health.report().markets.NVDA.lastBlock).not.toBe("0");
  });

  it("LM-R31: a tripped guard pulls all free liquidity in one tick; new borrows then have nothing to take", async () => {
    await a.send(a.d.roles.guardian, a.d.stocks.NVDA.oracle, call(stocklineOracleAbi, "trip", [1n]));
    const actions = await allocator.tick();
    expect(actions.NVDA.kind).toBe("deallocate");
    const m = await a.client.readContract({address: a.d.morpho, abi: morphoAbi, functionName: "market", args: [a.d.stocks.NVDA.marketId]});
    expect(m.totalSupplyAssets - m.totalBorrowAssets).toBe(10n ** 12n); // only the dead-address seed remains
    expect((await allocator.tick()).NVDA.kind).toBe("none");
    await a.send(a.d.roles.guardian, a.d.stocks.NVDA.oracle, call(stocklineOracleAbi, "clear", [1n]));
    expect((await allocator.tick()).NVDA.kind).toBe("allocate");
  });

  it("D5: pulls liquidity ahead of an earnings window until a round after the print", async () => {
    const now = (await a.client.getBlock()).timestamp;
    const start = now + 3n * 3600n;
    const end = start + 3600n;
    await a.send(
      a.d.timelock,
      a.d.marketHours,
      call(marketHoursAbi, "replaceEventsFrom", [a.d.stocks.NVDA.stockToken, 0n, [{startTs: start, endTs: end, bufferWad: 10n ** 17n}]]),
    );
    expect((await allocator.tick()).NVDA.kind).toBe("deallocate");
    await freshRounds(a, end + 60n); // print released by a fresh round
    expect((await allocator.tick()).NVDA.kind).toBe("allocate");
  });

  it("markets without events or activity stay untouched", async () => {
    const actions = await allocator.tick();
    expect(actions.SPY.kind).toBe("none");
    expect(actions.AAPL.kind).toBe("none");
  });
});
