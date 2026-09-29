import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {keccak256, parseAbiItem, toBytes} from "viem";
import {anvil as anvilChain} from "viem/chains";
import {startAnvil, type Anvil} from "./anvil.js";
import {DEPLOYER, WED} from "./helpers.js";
import {assertVenueMirrorAllowed, LighterFundingFeed, percentToWad, VenueMirror, type FundingFeed, type FundingPeriod} from "../src/venueMirror/mirror.js";
import {rpcUnlockedSender} from "../src/common/signer.js";

const applied = parseAbiItem("event FundingApplied(bytes32 indexed market, int256 rateWad, int256 payment)");

/** A49: Lighter's real hourly funding applied to the testnet mock venue, once per period, restart-safe. */
describe("venue mirror (Lighter funding → mock venue)", () => {
  let a: Anvil;
  const series: Record<number, FundingPeriod[]> = {26: [], 15: [], 10: []};
  const feed: FundingFeed = {since: async (id, since) => series[id].filter((p) => p.timestamp > since)};
  const mirror = () => new VenueMirror(a.client, rpcUnlockedSender(a.client, a.url, anvilChain, DEPLOYER), a.d, feed, undefined, () => {});

  beforeAll(async () => {
    a = await startAnvil();
    await a.setTime(WED);
    await a.test.impersonateAccount({address: DEPLOYER});
  });
  afterAll(() => a?.stop());

  const fundingLogs = async (ticker: string) =>
    a.client.getLogs({address: a.d.dnVault!.perpAdapter, event: applied, args: {market: keccak256(toBytes(ticker))}, fromBlock: 0n, toBlock: "latest"});

  it("applies each new Lighter period to the matching venue market (keccak256(ticker)), with the sign of the payer", async () => {
    const t = Number(WED);
    series[15] = [
      {timestamp: t - 7200, rateWad: 8n * 10n ** 12n},
      {timestamp: t - 3600, rateWad: -2n * 10n ** 12n},
    ];
    const m = mirror();
    expect(await m.tick()).toHaveLength(2);
    const logs = await fundingLogs("NVDA");
    expect(logs.map((l) => l.args.rateWad)).toEqual([8n * 10n ** 12n, -2n * 10n ** 12n]);
    expect(await fundingLogs("SPY")).toHaveLength(0);
    expect(await m.tick()).toEqual([]); // nothing new → no transaction
  });

  it("restart-safe: a fresh mirror resumes after the venue's last FundingApplied", async () => {
    await a.test.increaseTime({seconds: 3600});
    await a.test.mine({blocks: 1});
    const head = Number((await a.client.getBlock()).timestamp);
    series[15].push({timestamp: head + 60, rateWad: 10n ** 13n});
    const fresh = mirror();
    expect(await fresh.tick()).toEqual([`NVDA ${head + 60} ${10n ** 13n}`]);
    expect(await fundingLogs("NVDA")).toHaveLength(3);
  });

  it("parses Lighter's API: percent per hour, direction long = longs pay shorts", async () => {
    const body = {fundings: [
      {timestamp: 200, rate: "0.0008", direction: "short"},
      {timestamp: 100, rate: "0.0012", direction: "long"},
      {timestamp: 50, rate: "0.5", direction: "long"},
    ]};
    const f = new LighterFundingFeed("https://api.rh.lighter.xyz", (async () => new Response(JSON.stringify(body))) as typeof fetch);
    expect(await f.since(15, 60)).toEqual([
      {timestamp: 100, rateWad: 12n * 10n ** 12n}, // 0.0012 % = 1.2e-5
      {timestamp: 200, rateWad: -8n * 10n ** 12n},
    ]);
    expect(percentToWad("100")).toBe(10n ** 18n);
    expect(percentToWad("0.00000000000000019")).toBe(1n); // truncated below 1 wei
    // Caught up (since = the last period): the query still spans 24h, never a sub-hour window Lighter rejects (400).
    let url = "";
    const spy = new LighterFundingFeed("https://api.rh.lighter.xyz", (async (u: string) => ((url = u), new Response(JSON.stringify({fundings: []})))) as typeof fetch);
    await spy.since(15, Math.floor(Date.now() / 1000) - 60);
    const q = new URL(url).searchParams;
    expect(Number(q.get("end_timestamp")) - Number(q.get("start_timestamp"))).toBe(24 * 3600);
    const down = new LighterFundingFeed("https://api.rh.lighter.xyz", (async () => new Response("", {status: 503})) as typeof fetch);
    await expect(down.since(15, 0)).rejects.toThrow("lighter fundings 503");
  });

  it("MN-R6: never on mainnet 4663 or its fork", () => {
    expect(() => assertVenueMirrorAllowed(4663, a.d)).toThrow(/never runs on Robinhood Chain mainnet/);
    expect(() => assertVenueMirrorAllowed("fork-4663", a.d)).toThrow(/never runs on Robinhood Chain mainnet/);
    expect(() => assertVenueMirrorAllowed(31337, a.d)).not.toThrow();
  });
});
