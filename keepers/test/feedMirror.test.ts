import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {aggregatorV3Abi, mockSwapAggregatorAbi, stocklineOracleAbi} from "@stockline/sdk";
import {anvil as anvilChain} from "viem/chains";
import {startAnvil, type Anvil} from "./anvil.js";
import {DEPLOYER, WED} from "./helpers.js";
import {FeedMirror, type PriceSource, type Round} from "../src/feedMirror/mirror.js";
import {rpcUnlockedSender} from "../src/common/signer.js";

/** Phase 2 task 7: mainnet rounds mirrored to the mock feeds and mock DEX, idempotent and restart-safe. */
describe("feed mirror (testnet mock feeds)", () => {
  let a: Anvil;
  const rounds: Record<string, Round> = {SPY: {answer: 780_00000000n, updatedAt: 1n}, NVDA: {answer: 230_00000000n, updatedAt: 1n}, AAPL: {answer: 340_00000000n, updatedAt: 1n}, USDG: {answer: 99_990000n, updatedAt: 1n}};
  const source: PriceSource = {latest: async (s) => rounds[s]};
  let mirror: FeedMirror;

  beforeAll(async () => {
    a = await startAnvil();
    await a.setTime(WED);
    await a.test.impersonateAccount({address: DEPLOYER});
    mirror = new FeedMirror(a.client, rpcUnlockedSender(a.client, a.url, anvilChain, DEPLOYER), a.d, source, undefined, () => {});
  });
  afterAll(() => a?.stop());

  const answer = async (feed: `0x${string}`) => (await a.client.readContract({address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData"}))[1];

  it("pushes each new source round to the feed and moves the DEX to the same price", async () => {
    expect((await mirror.tick()).length).toBe(4);
    expect(await answer(a.d.mocks!.NVDA_feed)).toBe(230_00000000n);
    expect(await answer(a.d.mocks!.usdgFeed)).toBe(99_990000n);
    const rate = await a.client.readContract({address: a.d.mocks!.swapAggregator, abi: mockSwapAggregatorAbi, functionName: "rate", args: [a.d.stocks.NVDA.stockToken, a.d.usdg]});
    expect(rate).toBe(230_000000n);
    const [p] = await a.client.readContract({address: a.d.stocks.NVDA.oracle, abi: stocklineOracleAbi, functionName: "stockAnswer"});
    expect(p).toBe(230_00000000n); // the oracle accepts it (inside the OR-R7 band)
  });

  it("no new source round (e.g. the weekend freeze) → no transaction", async () => {
    expect(await mirror.tick()).toEqual([]);
    rounds.NVDA = {answer: 232_00000000n, updatedAt: 2n};
    expect(await mirror.tick()).toEqual(["NVDA 23200000000"]);
  });

  it("restart-safe: a fresh mirror does not re-push rounds the feeds already show", async () => {
    const fresh = new FeedMirror(a.client, rpcUnlockedSender(a.client, a.url, anvilChain, DEPLOYER), a.d, source, undefined, () => {});
    expect(await fresh.tick()).toEqual([]);
  });
});
