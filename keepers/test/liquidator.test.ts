import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {encodeFunctionData, parseAbi} from "viem";
import {anvil as anvilChain} from "viem/chains";
import {erc20Abi, mockAggregatorAbi, morphoAbi} from "@lendora/sdk";
import {ChainDriver} from "@lendora/devnet";
import {startAnvil, type Anvil} from "./anvil.js";
import {call, DEPLOYER, freshRounds, lend, WED} from "./helpers.js";
import {Allocator} from "../src/allocator/allocator.js";
import {rpcUnlockedSender} from "../src/common/signer.js";
import {marketParams} from "../src/common/market.js";
import {LiquidatorBot, liquidationIncentiveFactor, mockDexBuilder, planLiquidation} from "../src/liquidator/liquidator.js";

const E18 = 10n ** 18n;

describe("planLiquidation (pure)", () => {
  const price100 = 10n ** 46n; // $100 NVDA, $1 USDG
  it("LIF at 77% is 1.0741", () => {
    expect(liquidationIncentiveFactor(77n * 10n ** 16n)).toBe(1074113856068743286n);
  });
  it("healthy positions are skipped", () => {
    expect(planLiquidation({borrower: "0x01", collateral: 1500n * 10n ** 6n, borrowShares: 1n, borrowed: 10n * E18}, price100, 77n * 10n ** 16n, 100n * 10n ** 8n, 8, 200n)).toBeUndefined();
  });
  it("full liquidation with profit when collateral covers debt x LIF", () => {
    const price120 = (10n ** 46n * 100n) / 120n;
    const plan = planLiquidation({borrower: "0x01", collateral: 1500n * 10n ** 6n, borrowShares: 7n, borrowed: 10n * E18}, price120, 77n * 10n ** 16n, 120n * 10n ** 8n, 8, 200n)!;
    expect(plan.badDebt).toBe(false);
    expect(plan.repaidShares).toBe(7n);
    expect(plan.expectedSeized).toBeGreaterThan(1280n * 10n ** 6n);
    expect(plan.usdgIn).toBe(1224n * 10n ** 6n + 1n); // $1,200 + 2% headroom
    expect(plan.expectedProfit > 0n).toBe(true);
  });
  it("bad debt: seize all collateral", () => {
    const price200 = (10n ** 46n * 100n) / 200n;
    const plan = planLiquidation({borrower: "0x01", collateral: 1500n * 10n ** 6n, borrowShares: 7n, borrowed: 10n * E18}, price200, 77n * 10n ** 16n, 200n * 10n ** 8n, 8, 200n)!;
    expect(plan.badDebt).toBe(true);
    expect(plan.seizedAssets).toBe(1500n * 10n ** 6n);
    expect(plan.repaidShares).toBe(0n);
    expect(plan.usdgIn <= plan.expectedSeized).toBe(true);
  });
});

describe("fallback liquidator bot on anvil with the task-7 deployment", () => {
  let a: Anvil;
  const lender = "0x00000000000000000000000000000000000000a1" as const;
  const borrower = "0x00000000000000000000000000000000000000b0" as const;
  const keeperAddr = "0x976EA74026E726554dB657fA54763abd0C3a0aa9" as const; // anvil account 6 (unlocked)
  const dexAbi = parseAbi(["function setRate(address tokenIn, address tokenOut, uint256 rateWad)"]);

  beforeAll(async () => {
    a = await startAnvil();
    await freshRounds(a, WED);
    await lend(a, "NVDA", lender, 500n * E18);
    await a.test.impersonateAccount({address: a.d.roles.allocator});
    await new Allocator(a.client, rpcUnlockedSender(a.client, a.url, anvilChain, a.d.roles.allocator), a.d, undefined, undefined, () => {}).tick();
    // A position sized directly on Morpho: collateral through the attested router entry with a dust borrow (RT-R8:
    // collateral only enters with debt), then the loan without the router (05 §1 residual).
    const nvda = a.d.stocks.NVDA;
    const dust = 10n ** 9n;
    await new ChainDriver(a, {log: () => {}}).borrow("NVDA", borrower, 3_500_000_000n, dust);
    await a.send(borrower, a.d.morpho, encodeFunctionData({abi: morphoAbi, functionName: "borrow", args: [marketParams(a.d, nvda), 10n * E18 - dust, 0n, borrower, borrower]}));
  });
  afterAll(() => a?.stop());

  it("leaves healthy positions alone, liquidates after a +42% move, and the contract keeps nothing", async () => {
    await a.test.impersonateAccount({address: keeperAddr});
    const bot = new LiquidatorBot(
      a.client,
      rpcUnlockedSender(a.client, a.url, anvilChain, keeperAddr),
      a.d,
      mockDexBuilder(a.d.mocks!.swapAggregator),
      keeperAddr,
      {slippageBps: 200n, minProfit: 1_000_000n, fromBlock: 0n},
      undefined,
      () => {},
    );
    expect(await bot.tick()).toHaveLength(0);

    const nvda = a.d.stocks.NVDA;
    await a.send(DEPLOYER, a.d.mocks!.NVDA_feed, encodeFunctionData({abi: mockAggregatorAbi, functionName: "setAnswer", args: [320n * 10n ** 8n]}));
    const rate = (10n ** 8n * 10n ** 36n) / (320n * 10n ** 8n * 10n ** 6n);
    await a.send(DEPLOYER, a.d.mocks!.swapAggregator, call(dexAbi, "setRate", [a.d.usdg, nvda.stockToken, rate]));

    const done = await bot.tick();
    expect(done).toHaveLength(1);
    const pos = await a.client.readContract({address: a.d.morpho, abi: morphoAbi, functionName: "position", args: [nvda.marketId, borrower]});
    expect(pos.borrowShares).toBe(0n);
    const profit = await a.client.readContract({address: a.d.usdg, abi: erc20Abi, functionName: "balanceOf", args: [keeperAddr]});
    expect(profit > 100_000_000n).toBe(true);
    for (const t of [a.d.usdg, a.d.clUSDG, nvda.stockToken, nvda.wrapper]) {
      expect(await a.client.readContract({address: t, abi: erc20Abi, functionName: "balanceOf", args: [a.d.liquidator!]})).toBe(0n);
    }
    expect(await bot.tick()).toHaveLength(0); // idempotent
  });
});
