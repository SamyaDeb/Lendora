import {afterAll, beforeAll, describe, expect, it} from "vitest";
import pg from "pg";
import {encodeFunctionData, maxUint256, type Hex} from "viem";
import {anvil as anvilChain} from "viem/chains";
import {deltaNeutralVaultAbi, erc20Abi, mockPerpVenueAbi, mockUsdgAbi, strategyManagerAbi} from "@lendora/sdk";
import {ChainDriver, startPostgres, type Service} from "@lendora/devnet";
import {startAnvil, type Anvil} from "./anvil.js";
import {WED} from "./helpers.js";
import {rpcUnlockedSender, rpcUnlockedTypedDataSigner} from "../src/common/signer.js";
import {MockVenueSource, NavCosigner, NavReporter, sleeveMarkets} from "../src/navReporter/navReporter.js";
import {defaultDnParams, DnRebalancer, mockDexSwapBuilder, MockVenueMargin} from "../src/dnRebalancer/rebalancer.js";
import {MockVenueFunding} from "../src/dnRebalancer/funding.js";
import {FakePager, Monitor, MonitorStore, type RuleId} from "../src/monitor/index.js";

const E6 = 10n ** 6n;
const E18 = 10n ** 18n;
const OPERATOR = "0x976EA74026E726554dB657fA54763abd0C3a0aa9" as const;
const GUARDIAN = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const; // DeployLocal guardian (anvil #3)
const NAV1 = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f" as const;
const NAV2 = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720" as const;
const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const alice = "0x00000000000000000000000000000000000e1a12" as const;
const call = (abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => (encodeFunctionData as (p: unknown) => Hex)({abi, functionName, args});

/** MON-R21…R25 (delta-neutral vault) on anvil: each rule fires once and resolves once from real chain conditions (a
 * short left off-band, venue margin drained by funding, reports stopped, an overdue queue, a killed sleeve). */
describe("ops monitor: USDG Earn (MON-R21…R25)", () => {
  let a: Anvil;
  let drv: ChainDriver;
  let pgs: Service;
  let pool: pg.Pool;
  let monitor: Monitor;
  let markets: Hex[];
  const pager = new FakePager();
  const dn = () => a.d.dnVault!;
  const count = (rule: RuleId, action: "trigger" | "resolve") => pager.of(rule, action).length;
  const bump = async (sec = 1n) => a.setTime((await a.client.getBlock()).timestamp + sec);
  const source = () => new MockVenueSource(a.client, dn().perpAdapter, markets);
  const report = async () => {
    await bump();
    const co = new NavCosigner(a.client, rpcUnlockedTypedDataSigner(a.url, NAV2, 31337), a.d, source(), 31337);
    const r = await new NavReporter(a.client, rpcUnlockedSender(a.client, a.url, anvilChain, NAV1), rpcUnlockedTypedDataSigner(a.url, NAV1, 31337), a.d, source(), 31337, co, {everyMs: 0, moveBps: 0n}, undefined, () => {}).tick();
    expect(r.submitted, r.reason).toBe(true);
  };
  const rebalance = () =>
    new DnRebalancer(a.client, rpcUnlockedSender(a.client, a.url, anvilChain, OPERATOR), a.d, mockDexSwapBuilder(a.d.mocks!.swapAggregator), new MockVenueMargin(a.client, dn().perpAdapter), new MockVenueFunding(a.client, dn().perpAdapter, markets), {...defaultDnParams, entryChunkUsdg: 400_000n * E6}, undefined, () => {}).tick();
  const op = (fn: string, args: readonly unknown[]) => a.send(OPERATOR, dn().strategy, call(strategyManagerAbi, fn, args));

  /** Fires once on `enter` (after `holdSec` of chain time for duration rules), stays deduped, resolves once on `leave`. */
  async function firesAndResolves(rule: RuleId, enter: () => Promise<void>, leave: () => Promise<void>, holdSec = 0n) {
    const t0 = count(rule, "trigger");
    const r0 = count(rule, "resolve");
    await enter();
    await monitor.tick();
    if (holdSec > 0n) {
      expect(count(rule, "trigger") - t0, `${rule} waits ${holdSec}s`).toBe(0);
      await bump(holdSec + 1n);
      await monitor.tick();
    }
    expect(count(rule, "trigger") - t0, `${rule} trigger`).toBe(1);
    await monitor.tick();
    expect(count(rule, "trigger") - t0, `${rule} deduped`).toBe(1);
    await leave();
    await monitor.tick();
    expect(count(rule, "resolve") - r0, `${rule} resolve`).toBe(1);
    expect(pager.of(rule, "trigger").at(-1)!.key).toContain(rule);
  }

  beforeAll(async () => {
    a = await startAnvil();
    pgs = await startPostgres();
    pool = new pg.Pool({connectionString: pgs.url});
    const store = new MonitorStore(pool, `monitor_dn_${Date.now()}`);
    await store.migrate();
    drv = new ChainDriver(a, {log: () => {}});
    await drv.freshRounds(WED);
    markets = await sleeveMarkets(a.client, dn().strategy);
    for (const t of drv.tickers) {
      await drv.mintStock(t, DEPLOYER, 20_000n * E18);
      await drv.lend(t, DEPLOYER, 20_000n * E18);
    }
    await drv.mintUsdg(alice, 1_000_000n * E6);
    const att = await drv.attest(alice);
    await a.send(alice, a.d.usdg, call(erc20Abi, "approve", [dn().vault, maxUint256]));
    await report();
    await a.send(alice, dn().vault, call(deltaNeutralVaultAbi, "deposit", [1_000_000n * E6, alice, att]));
    for (let i = 0; i < 4; i++) {
      await report();
      await rebalance();
    }
    await report();
    monitor = new Monitor(a.client, a.d, store, [pager], {borrowers: async () => []}, {log: () => {}, renotifyMs: {P0: 3600_000, P1: 3600_000, P2: 3600_000}});
  }, 600_000);

  afterAll(async () => {
    await pool?.end();
    pgs?.stop();
    a?.stop();
  });

  it("MON quiet vault: no DN page", async () => {
    await monitor.tick();
    await monitor.tick();
    expect(pager.sent.filter((p) => p.key.includes("DN_"))).toEqual([]);
  });

  it("MON_R21 DN_DELTA_BREACH: a short left 10% under spot for 30 minutes, then realigned", async () => {
    const [, size] = await a.client.readContract({address: dn().perpAdapter, abi: mockPerpVenueAbi, functionName: "shortSize", args: [markets[1]]});
    await firesAndResolves(
      "DN_DELTA_BREACH",
      // Report right after each trade (as the reporter does), so only the band is off, not the NAV.
      () => op("adjustShort", [1n, size / 10n, 0n]).then(report),
      () => op("adjustShort", [1n, -(size / 10n), 0n]).then(report),
      1800n,
    );
  }, 300_000);

  it("MON_R23 DN_NAV_STALE: reports stop for 20 minutes, then resume", async () => {
    await report();
    await monitor.tick(); // fresh: nothing open, no watch
    await firesAndResolves("DN_NAV_STALE", () => bump(20n * 60n), () => report(), 300n);
  }, 300_000);

  it("MON_R22 DN_MARGIN_LOW: negative funding drains the venue margin, a top-up restores it", async () => {
    await report();
    await firesAndResolves(
      "DN_MARGIN_LOW",
      () => a.send(DEPLOYER, dn().perpAdapter, call(mockPerpVenueAbi, "applyFunding", [markets[0], -(60n * 10n ** 16n)])).then(() => {}),
      async () => {
        await a.send(DEPLOYER, a.d.usdg, call(mockUsdgAbi, "mint", [dn().strategy, 200_000n * E6]));
        await op("depositMargin", [200_000n * E6]);
      },
    );
    expect(pager.of("DN_MARGIN_LOW", "trigger").at(-1)!.severity).toBe("P0");
  }, 300_000);

  it("MON_R24 DN_QUEUE_OVERDUE: a request past its settlement deadline, then settled", async () => {
    await report();
    const shares = await a.client.readContract({address: dn().vault, abi: erc20Abi, functionName: "balanceOf", args: [alice]});
    await a.send(alice, dn().vault, call(deltaNeutralVaultAbi, "requestRedeem", [shares / 2n, alice, alice]));
    const head = (await a.client.readContract({address: dn().vault, abi: deltaNeutralVaultAbi, functionName: "queueBounds"}))[0];
    const req = await a.client.readContract({address: dn().vault, abi: deltaNeutralVaultAbi, functionName: "request", args: [head]});
    await firesAndResolves(
      "DN_QUEUE_OVERDUE",
      async () => {
        await drv.freshRounds(BigInt(req.settleBy) + 3600n); // the deadline passes with the queue unserved
      },
      async () => {
        for (let i = 0; i < 3; i++) {
          await report();
          await rebalance();
        }
        await report();
        await rebalance();
        const [h, t] = await a.client.readContract({address: dn().vault, abi: deltaNeutralVaultAbi, functionName: "queueBounds"});
        expect(h).toBe(t);
      },
    );
  }, 600_000);

  it("MON_R25 DN_KILL_SWITCH: the guardian kills a sleeve, the rebalancer unwinds it", async () => {
    await firesAndResolves(
      "DN_KILL_SWITCH",
      () => a.send(GUARDIAN, dn().strategy, call(strategyManagerAbi, "killSleeve", [2n])).then(() => {}),
      async () => {
        await report();
        await rebalance();
        await report();
      },
    );
  }, 300_000);
});
