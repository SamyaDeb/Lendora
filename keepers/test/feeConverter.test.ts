import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {encodeFunctionData, parseAbi} from "viem";
import {anvil as anvilChain} from "viem/chains";
import {erc20Abi, mockUsdgAbi, vaultV2FullAbi} from "@stockline/sdk";
import {ChainDriver} from "@stockline/devnet";
import {startAnvil, type Anvil} from "./anvil.js";
import {DEPLOYER, freshRounds, lend, WED} from "./helpers.js";
import {Allocator} from "../src/allocator/allocator.js";
import {DryRunSender, rpcUnlockedSender} from "../src/common/signer.js";
import {defaultFeeConverterOptions, FeeConverterBot, mockDexSellBuilder, UR_CONTRACT_BALANCE, universalRouterSellBuilder} from "../src/feeConverter/feeConverter.js";

const E18 = 10n ** 18n;
const DAY = 86_400n;
const SAT = WED + 3n * DAY; // Sat 2026-10-03 12:00 ET: feed closed
const dexAbi = parseAbi(["function setRate(address tokenIn, address tokenOut, uint256 rateWad)"]);

/** FE-R4 keeper on anvil with the DeployLocal fixture (FeeSplitter + two FeeConverters, mock DEX). */
describe("fee-converter keeper on anvil (FE-R4)", () => {
  let a: Anvil;
  const lender = "0x00000000000000000000000000000000000000c1" as const;
  const borrower = "0x00000000000000000000000000000000000000c2" as const;
  const opts = {...defaultFeeConverterOptions, minUsdg: 1_000n, regularHoursOnly: true};
  const usdgOf = (who: `0x${string}`) => a.client.readContract({address: a.d.usdg, abi: erc20Abi, functionName: "balanceOf", args: [who]});
  const sharesOf = (who: `0x${string}`) => a.client.readContract({address: a.d.stocks.NVDA.vault, abi: erc20Abi, functionName: "balanceOf", args: [who]});
  const bot = (sender = rpcUnlockedSender(a.client, a.url, anvilChain, a.d.roles.feeKeeper!)) =>
    new FeeConverterBot(a.client, sender, a.d, mockDexSellBuilder(a.d.mocks!.swapAggregator), opts, undefined, () => {});

  async function accrue(to: bigint) {
    await freshRounds(a, to);
    await a.send(DEPLOYER, a.d.stocks.NVDA.vault, encodeFunctionData({abi: vaultV2FullAbi, functionName: "accrueInterest"}));
  }

  beforeAll(async () => {
    a = await startAnvil();
    await freshRounds(a, WED);
    await lend(a, "NVDA", lender, 500n * E18);
    await a.test.impersonateAccount({address: a.d.roles.allocator});
    await new Allocator(a.client, rpcUnlockedSender(a.client, a.url, anvilChain, a.d.roles.allocator), a.d, undefined, undefined, () => {}).tick();
    await new ChainDriver(a, {log: () => {}}).borrow("NVDA", borrower, 60_000n * 10n ** 6n, 150n * E18);
    await a.test.impersonateAccount({address: a.d.roles.feeKeeper!});
    // The mock DEX pays the feed price for NVDA (USDG 6 dp per 1e18 raw) and holds USDG.
    await a.send(DEPLOYER, a.d.mocks!.swapAggregator, encodeFunctionData({abi: dexAbi, functionName: "setRate", args: [a.d.stocks.NVDA.stockToken, a.d.usdg, 225_66000000n / 100n]}));
    await a.send(DEPLOYER, a.d.usdg, encodeFunctionData({abi: mockUsdgAbi, functionName: "mint", args: [a.d.mocks!.swapAggregator, 10n ** 15n]}));
  }, 300_000);
  afterAll(() => a?.stop());

  it("dry run plans but sends nothing", async () => {
    await accrue(WED + 30n * DAY); // Fri 2026-10-30 12:00 ET, regular session
    const dry = new DryRunSender(a.d.roles.feeKeeper);
    const plans = await bot(dry).tick();
    expect(plans.map((p) => p.kind)).toEqual(["distribute"]); // conversions need the distribution first
    expect(dry.sent.map((s) => s.label)).toEqual(["distribute NVDA"]);
    expect(await sharesOf(a.d.feeSplitter!)).toBeGreaterThan(0n);
  });

  it("first run: distributes, converts both shares within 1% of the oracle, USDG lands at the multisigs", async () => {
    const [t0, b0] = [await usdgOf(a.d.roles.treasury!), await usdgOf(a.d.roles.backstopReserve!)];
    const plans = await bot().tick();
    expect(plans.map((p) => `${p.kind}:${p.converter ?? ""}:${p.reason}`)).toEqual(["distribute::period", "convert:treasury:period", "convert:backstop:period"]);
    const [t1, b1] = [await usdgOf(a.d.roles.treasury!), await usdgOf(a.d.roles.backstopReserve!)];
    const conv = plans.filter((p) => p.kind === "convert");
    expect(t1 - t0).toBeGreaterThanOrEqual(conv[0].minUsdgOut!);
    expect(b1 - b0).toBeGreaterThanOrEqual(conv[1].minUsdgOut!);
    for (const p of conv) expect(p.minUsdgOut! * 10_000n >= p.valueUsdg * 9_900n).toBe(true);
    expect(await sharesOf(a.d.feeSplitter!)).toBe(0n);
    expect(await sharesOf(a.d.treasuryConverter!)).toBe(0n);
    expect(await sharesOf(a.d.backstopConverter!)).toBe(0n);
    expect(await usdgOf(a.d.roles.feeKeeper!)).toBe(0n); // the keeper never receives funds
  }, 120_000);

  it("replays and restarts are no-ops; the weekly period comes from chain events", async () => {
    expect(await bot().tick()).toHaveLength(0); // nothing left to do
    await accrue(WED + 31n * DAY); // one more day of fees, far below $1k
    const fresh = bot(); // a restarted keeper: no local state, reads the last Distributed/Converted events
    expect(await fresh.tick()).toHaveLength(0);
  }, 120_000);

  it("closed feed session: distribution may run, conversion waits for the session", async () => {
    await accrue(SAT + 35n * DAY); // a Saturday more than a week after the last conversion
    const plans = await bot().tick();
    expect(plans.map((p) => p.kind)).toEqual(["distribute"]);
    expect(await sharesOf(a.d.treasuryConverter!)).toBeGreaterThan(0n);
    await accrue(SAT + 37n * DAY); // Monday 12:00 ET
    const later = await bot().tick();
    expect(later.filter((p) => p.kind === "convert")).toHaveLength(2);
  }, 120_000);
});

describe("UniversalRouter sell calldata (FE-R4, A15)", () => {
  it("swaps the router's whole balance (CONTRACT_BALANCE) along stock → 0.05% → USDG to the converter", () => {
    const b = universalRouterSellBuilder("0x8876000000000000000000000000000000000904");
    const stock = "0x1111111111111111111111111111111111111111" as const;
    const usdg = "0x2222222222222222222222222222222222222222" as const;
    const data = b.sell(stock, usdg, 5n, "0x3333333333333333333333333333333333333333");
    expect(data.startsWith("0x3593564c")).toBe(true); // execute(bytes,bytes[],uint256)
    expect(data).toContain(UR_CONTRACT_BALANCE.toString(16));
    expect(data).toContain(`${stock.slice(2)}0001f4${usdg.slice(2)}`);
  });
});
