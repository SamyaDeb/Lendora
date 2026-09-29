import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {encodeFunctionData, type Hex} from "viem";
import {anvil as anvilChain} from "viem/chains";
import {deltaNeutralVaultAbi, marketHoursAbi, mockPerpVenueAbi} from "@stockline/sdk";
import {ChainDriver, DnDriver, DN_OPERATOR, NAV_SIGNERS} from "@stockline/devnet";
import {startAnvil, type Anvil} from "./anvil.js";
import {WED} from "./helpers.js";
import {rpcUnlockedSender, rpcUnlockedTypedDataSigner} from "../src/common/signer.js";
import {MockVenueSource, NavCosigner, NavReporter, sleeveMarkets} from "../src/navReporter/navReporter.js";
import {defaultDnParams, DnRebalancer, mockDexSwapBuilder, MockVenueMargin} from "../src/dnRebalancer/rebalancer.js";
import {MockVenueFunding} from "../src/dnRebalancer/funding.js";

const E6 = 10n ** 6n;
const E18 = 10n ** 18n;
const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const STEP = 1800n; // 30 minutes

/** Real Lighter hourly funding (task 13 cache), as WAD rates per hour, for a sleeve's market. */
function lighterFunding(sym: string): bigint[] {
  const csv = readFileSync(fileURLToPath(new URL(`../../sim/data/lighter/${sym}_funding.csv`, import.meta.url)), "utf8").trim().split("\n").slice(1);
  return csv.map((l) => BigInt(Math.round(Number(l.split(",")[1]) * 1e18)));
}

/** Seeded PRNG (mulberry32): the week is reproducible. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Phase 4 task 17 (08 acceptance rehearsal): a seeded vault week on anvil. The NAV reporter (+ co-signer) and the
 * rebalancer keepers run every 30 minutes of chain time for 7 days; prices random-walk (±0.4% per step) while the feed
 * session is open and freeze on the weekend; the mock venue pays the real Lighter hourly funding of 2026-07 (sim
 * cache). Passes when the delta is inside the ±2% band on ≥ 99% of sleeve-ticks (the 30-day run's criterion) and the
 * vault never loses more than the entry costs.
 */
describe("DN vault week on anvil (task 17)", () => {
  let a: Anvil;
  let drv: ChainDriver;
  let dn: DnDriver;
  let markets: Hex[];
  const alice = "0x00000000000000000000000000000000000e1a14" as const;

  beforeAll(async () => {
    a = await startAnvil();
    drv = new ChainDriver(a, {log: () => {}});
    dn = new DnDriver(drv);
    await drv.freshRounds(WED);
    markets = await sleeveMarkets(a.client, a.d.dnVault!.strategy);
    for (const t of drv.tickers) {
      await drv.mintStock(t, DEPLOYER, 30_000n * E18);
      await drv.lend(t, DEPLOYER, 30_000n * E18);
    }
    await dn.report();
    await dn.deposit(alice, 1_000_000n * E6);
  }, 300_000);
  afterAll(() => a?.stop());

  it("DN-R2 delta inside the band on ≥ 99% of ticks over a simulated week; NAV holds", async () => {
    const source = () => new MockVenueSource(a.client, a.d.dnVault!.perpAdapter, markets);
    const cosigner = new NavCosigner(a.client, rpcUnlockedTypedDataSigner(a.url, NAV_SIGNERS[1], 31337), a.d, source(), 31337);
    const reporter = new NavReporter(a.client, rpcUnlockedSender(a.client, a.url, anvilChain, NAV_SIGNERS[0]), rpcUnlockedTypedDataSigner(a.url, NAV_SIGNERS[0], 31337), a.d, source(), 31337, cosigner, {everyMs: 10 * 60_000, moveBps: 50n}, undefined, () => {});
    const rebalancer = new DnRebalancer(a.client, rpcUnlockedSender(a.client, a.url, anvilChain, DN_OPERATOR), a.d, mockDexSwapBuilder(a.d.mocks!.swapAggregator), new MockVenueMargin(a.client, a.d.dnVault!.perpAdapter), new MockVenueFunding(a.client, a.d.dnVault!.perpAdapter, markets), {...defaultDnParams, entryChunkUsdg: 250_000n * E6}, undefined, () => {});
    const funding = {SPY: lighterFunding("SPY"), NVDA: lighterFunding("NVDA"), AAPL: lighterFunding("AAPL")} as Record<string, bigint[]>;
    const rand = rng(7);
    const nav0 = await a.client.readContract({address: a.d.dnVault!.vault, abi: deltaNeutralVaultAbi, functionName: "totalAssets"});
    let inBand = 0;
    let ticks = 0;
    let errors = 0;
    const kinds = new Map<string, number>();
    let t = await drv.now();
    const end = t + 7n * 86_400n;
    let hour = 0;
    for (; t < end; t += STEP) {
      const open = await a.client.readContract({address: a.d.marketHours, abi: marketHoursAbi, functionName: "isOpen", args: [t]});
      if (open) {
        const next: Record<string, bigint> = {};
        for (const k of drv.tickers) next[k] = (drv.prices[k] * BigInt(Math.round(10_000 + (rand() - 0.5) * 80))) / 10_000n;
        await drv.freshRounds(t, next);
      } else await drv.warp(t);
      if ((t / STEP) % 2n === 0n) {
        // Hourly funding on each market, the real Lighter series (perps trade through the weekend).
        for (let i = 0; i < markets.length; i++) {
          const series = funding[drv.tickers[i]];
          await a.send(DEPLOYER, a.d.dnVault!.perpAdapter, encodeFunctionData({abi: mockPerpVenueAbi, functionName: "applyFunding", args: [markets[i], series[hour % series.length]]}));
        }
        hour++;
      }
      await reporter.tick();
      const r = await rebalancer.tick();
      errors += r.errors.length;
      for (const e of r.errors) kinds.set(e.slice(0, 140), (kinds.get(e.slice(0, 140)) ?? 0) + 1);
      await reporter.tick();
      inBand += r.inBand.filter(Boolean).length;
      ticks += r.inBand.length;
    }
    const nav1 = await a.client.readContract({address: a.d.dnVault!.vault, abi: deltaNeutralVaultAbi, functionName: "totalAssets"});
    const share = inBand / ticks;
    console.log(`[dn-week] ${ticks} sleeve-ticks, in band ${(share * 100).toFixed(2)}%, rebalancer errors ${errors}, NAV ${Number(nav0) / 1e6} → ${Number(nav1) / 1e6} USDG`);
    for (const [k, n] of kinds) console.log(`[dn-week] ${n}× ${k}`);
    expect(share).toBeGreaterThanOrEqual(0.99);
    expect(errors).toBe(0);
    expect(Number(nav1)).toBeGreaterThan(Number(nav0) * 0.995);
  }, 1_800_000);
});
