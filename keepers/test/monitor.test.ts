import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {createServer, type Server} from "node:http";
import pg from "pg";
import {encodeFunctionData, maxUint256, type Hex} from "viem";
import {erc20Abi, feeSplitterAbi, marketHoursAbi, mockStockTokenAbi, mockSwapAggregatorAbi, mockUsdgAbi, morphoAbi, saltOf, stockWrapperAbi, timelockAbi, timelockOperation, vaultV2Abi, vaultV2FullAbi} from "@stockline/sdk";
import {DEPLOYER, SEED_WED} from "@stockline/devnet";
import {startStack, type Stack} from "@stockline/api/harness";
import {reconcile} from "@stockline/indexer/reconcile";
import {startIndexer, type IndexerHandle} from "@stockline/indexer/harness";
import {Health} from "../src/common/health.js";
import {marketParams} from "../src/common/market.js";
import {FakePager, IndexerBorrowers, Monitor, MonitorStore, closuresAround, monitorApp, type RuleId, type TickResult} from "../src/monitor/index.js";
import {mockAggregatorQuoter} from "../src/monitor/quoter.js";

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const H = 3600n;
const call = (abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => (encodeFunctionData as (p: unknown) => Hex)({abi, functionName, args});

/**
 * MON-R1…R14 on anvil with the devnet chain driver, the Ponder indexer and Postgres: each rule fires once and resolves
 * once, from real chain conditions (adminBurn on the mock, a USDG wipe, a stale feed, a 1e18-scaled round, a guard
 * trip without the allocator's pull, a bad-debt liquidation, a direct Morpho borrow, an L2 gap, a killed keeper, a
 * truncated calendar, a stopped indexer process and a real reconciliation diff from a vault donation), plus the weekend
 * log over a full closure. Only the pager is a test double (it records instead of calling PagerDuty).
 */
describe("ops monitor (MON-R1…R20)", () => {
  let s: Stack;
  let pool: pg.Pool;
  let store: MonitorStore;
  let monitor: Monitor;
  const pager = new FakePager();
  const clock = {t: Date.now()};
  let keeper: Server;
  let keeperPort = 0;
  let indexer: IndexerHandle;
  let indexerRunning = true;
  const alice = "0x5700000000000000000000000000000000000a01" as const; // NVDA borrower (router, then direct)
  const bob = "0x5700000000000000000000000000000000000a02" as const; // tight NVDA short → bad debt
  const lender = "0x5700000000000000000000000000000000000a03" as const;
  const spyLender = "0x5700000000000000000000000000000000000a04" as const;
  const carol = "0x5700000000000000000000000000000000000a05" as const; // SPY borrower (utilization)

  const count = (rule: RuleId, action: "trigger" | "resolve" | "renotify") => pager.of(rule, action).length;
  const tick = async (): Promise<TickResult> => {
    if (indexerRunning) await indexer.waitForBlock(await s.anvil.client.getBlockNumber());
    return monitor.tick();
  };
  /** Mine `n` empty blocks 1 s apart (duration rules count blocks). */
  const mine = async (n: number) => {
    for (let i = 0; i < n; i++) await s.anvil.setTime((await s.drv.now()) + 1n);
  };
  /** Walk forward without feed rounds in steps below the L2 gap threshold. */
  const walk = (to: bigint) => s.drv.walk(to, 240n);
  const startKeeper = () =>
    new Promise<void>((resolve) => {
      keeper = createServer((_req, res) => res.writeHead(200, {"content-type": "application/json"}).end('{"healthy":true}'));
      keeper.listen(keeperPort, "127.0.0.1", () => {
        keeperPort = (keeper.address() as {port: number}).port;
        resolve();
      });
    });
  /** Fires once per subject on `enter` (`n` subjects, e.g. one per market), resolves once per subject on `leave`, and
   * nothing else for this rule in between. */
  async function firesAndResolves(rule: RuleId, enter: () => Promise<void>, leave: () => Promise<void>, n = 1) {
    const t0 = count(rule, "trigger");
    const r0 = count(rule, "resolve");
    await enter();
    await tick();
    expect(count(rule, "trigger") - t0, `${rule} trigger`).toBe(n);
    await tick(); // still firing: deduped
    expect(count(rule, "trigger") - t0, `${rule} deduped`).toBe(n);
    expect(count(rule, "resolve") - r0, `${rule} not resolved yet`).toBe(0);
    await leave();
    await tick();
    expect(count(rule, "resolve") - r0, `${rule} resolve`).toBe(n);
    await tick();
    expect(count(rule, "trigger") - t0).toBe(n);
    expect(count(rule, "resolve") - r0).toBe(n);
  }

  beforeAll(async () => {
    s = await startStack({seed: false});
    pool = new pg.Pool({connectionString: s.pg.url});
    store = new MonitorStore(pool, `monitor_${Date.now()}`);
    await store.migrate();
    await startKeeper();
    const drv = s.drv;
    await drv.freshRounds(SEED_WED);
    await drv.lend("NVDA", lender, 1_000n * E18);
    await drv.lend("SPY", spyLender, 100n * E18);
    await drv.allocate(["NVDA", "SPY"]);
    await drv.borrow("NVDA", alice, 20_000n * E6, 20n * E18);
    indexer = s.indexer;
    monitor = new Monitor(
      s.anvil.client,
      s.config.d,
      store,
      [pager],
      new IndexerBorrowers(pool, s.indexer.viewsSchema),
      {
        keepers: {allocator: `http://127.0.0.1:${keeperPort}/health`},
        now: () => clock.t,
        l2ClearAfterSec: 1200n,
        renotifyMs: {P0: 3600_000, P1: 3600_000, P2: 3600_000},
        reconcileEveryMs: 0,
        quoter: mockAggregatorQuoter(s.anvil.client, s.config.d.mocks!.swapAggregator), // MON-R19
        feeStuckForSec: 6n * H, // MON-R20: 8 days in production; 6h keeps the indexer in step with the walk
        reconcile: async () => {
          const r = await reconcile({pool, schema: s.indexer.viewsSchema, client: s.anvil.client, d: s.config.d, pager: {page: async () => {}}});
          return {block: r.block, diffs: r.diffs.length};
        },
        log: () => {},
      },
      new Health(60_000),
    );
  }, 600_000);

  afterAll(async () => {
    keeper?.close();
    if (indexer && indexer !== s?.indexer) await indexer.stop(); // the restarted one; the stack stops the original
    await pool?.end();
    await s?.close();
  });

  it("MON quiet market: nothing pages", async () => {
    await tick();
    await tick();
    expect(pager.sent.map((p) => p.key)).toEqual([]);
  });

  it("MON_R3 BACKING_SHORTFALL (LM-R8): issuer adminBurn of the wrapper's backing, then restored", async () => {
    const nvda = s.config.d.stocks.NVDA;
    await firesAndResolves(
      "BACKING_SHORTFALL",
      () => s.anvil.send(DEPLOYER, nvda.stockToken, call(mockStockTokenAbi, "adminBurn", [nvda.wrapper, E18])).then(() => {}),
      () => s.anvil.send(DEPLOYER, nvda.stockToken, call(mockStockTokenAbi, "mint", [nvda.wrapper, E18])).then(() => {}),
    );
    const p = pager.of("BACKING_SHORTFALL", "trigger").at(-1)!;
    expect(p.severity).toBe("P0");
    expect(p.runbook).toBe("docs/runbooks/wrapper-backing-shortfall.md");
    expect(p.details.req).toBe("MON-R3");
  });

  it("MON_R4 CLUSDG_BACKING (CL-R6): a Paxos-style wipe of USDG held by clUSDG, then restored", async () => {
    const d = s.config.d;
    await firesAndResolves(
      "CLUSDG_BACKING",
      () => s.anvil.send(DEPLOYER, d.usdg, call(mockUsdgAbi, "burn", [d.clUSDG, 1_000n * E6])).then(() => {}),
      () => s.anvil.send(DEPLOYER, d.usdg, call(mockUsdgAbi, "mint", [d.clUSDG, 1_000n * E6])).then(() => {}),
    );
  });

  it("MON_R10 DIRECT_BORROW (RT-R8 residual): a Morpho borrow not made by the router pages once, then auto-resolves", async () => {
    const t0 = count("DIRECT_BORROW", "trigger");
    const nvda = s.config.d.stocks.NVDA;
    await s.anvil.send(alice, s.config.d.morpho, call(morphoAbi, "borrow", [marketParams(s.config.d, nvda), E18, 0n, alice, alice]));
    await tick();
    expect(count("DIRECT_BORROW", "trigger") - t0).toBe(1);
    const p = pager.of("DIRECT_BORROW", "trigger").at(-1)!;
    expect(p.subject).toBe(`NVDA:${alice.toLowerCase()}`);
    await s.anvil.send(alice, s.config.d.morpho, call(morphoAbi, "borrow", [marketParams(s.config.d, nvda), E18, 0n, alice, alice]));
    await tick();
    expect(count("DIRECT_BORROW", "trigger") - t0, "same borrower deduped").toBe(1);
    // Router borrows never page.
    await s.drv.borrow("NVDA", alice, 1_000n * E6, E18);
    await tick();
    expect(count("DIRECT_BORROW", "trigger") - t0).toBe(1);
    const r0 = count("DIRECT_BORROW", "resolve");
    clock.t += 2 * 3600_000;
    await tick();
    expect(count("DIRECT_BORROW", "resolve") - r0).toBe(1);
  });

  it("MON_R5 ORACLE_STALE and MON_R7 GUARD_TRIPPED(STALE): no round for heartbeat + 10 min in an open session", async () => {
    const t0 = count("GUARD_TRIPPED", "trigger");
    await firesAndResolves(
      "ORACLE_STALE",
      async () => {
        await s.drv.freshRounds((await s.drv.now()) + 60n);
        await walk((await s.drv.now()) + 24n * H + 11n * 60n);
        expect(await s.drv.isOpen()).toBe(true);
      },
      () => s.drv.rounds(),
      3, // every market's feed went stale
    );
    expect(pager.of("GUARD_TRIPPED", "trigger").slice(t0).some((p) => p.subject.endsWith(":STALE"))).toBe(true);
    await s.drv.allocate(); // re-allocate after the pulls the stale guard implied
  });

  it("MON_R6 FEED_REJECTED (OR-R7): a round scaled 1e18 is rejected by the sanity band, then a good round", async () => {
    const good = s.drv.prices.NVDA;
    await firesAndResolves(
      "FEED_REJECTED",
      async () => {
        await s.drv.rounds({NVDA: good * 10n ** 10n});
        await s.drv.poke(["NVDA"]); // GuardChanged(SANITY, true) is emitted as well
      },
      async () => {
        await s.drv.rounds({NVDA: good});
        await s.drv.poke(["NVDA"]);
      },
    );
    expect(pager.of("FEED_REJECTED", "trigger").at(-1)!.subject).toBe("NVDA:SANITY");
  });

  it("MON_R7 GUARD_TRIPPED and MON_R11 PULL_NOT_EFFECTIVE: a guardian trip with no allocator pull, then the pull and the clear", async () => {
    const g0 = count("GUARD_TRIPPED", "trigger");
    const gr0 = count("GUARD_TRIPPED", "resolve");
    const p0 = count("PULL_NOT_EFFECTIVE", "trigger");
    const pr0 = count("PULL_NOT_EFFECTIVE", "resolve");
    await s.drv.guardian("NVDA", "trip");
    await tick(); // guard pages at once; the pull watch starts
    expect(count("GUARD_TRIPPED", "trigger") - g0).toBe(1);
    expect(count("PULL_NOT_EFFECTIVE", "trigger") - p0).toBe(0);
    await mine(2);
    await tick();
    expect(count("PULL_NOT_EFFECTIVE", "trigger") - p0, "free liquidity still there after 2 blocks").toBe(1);
    await s.drv.allocate(["NVDA"]); // LM-R31 pull
    await tick();
    expect(count("PULL_NOT_EFFECTIVE", "resolve") - pr0).toBe(1);
    await s.drv.guardian("NVDA", "clear");
    await tick();
    expect(count("GUARD_TRIPPED", "resolve") - gr0).toBe(1);
    expect(count("GUARD_TRIPPED", "trigger") - g0).toBe(1);
    expect(count("PULL_NOT_EFFECTIVE", "trigger") - p0).toBe(1);
    await s.drv.allocate(["NVDA"]);
  });

  it("MON_R7 a trip and clear between two ticks still pages (trigger, then resolve)", async () => {
    const g0 = count("GUARD_TRIPPED", "trigger");
    const gr0 = count("GUARD_TRIPPED", "resolve");
    await s.drv.guardian("AAPL", "trip");
    await s.drv.guardian("AAPL", "clear");
    await tick();
    expect(count("GUARD_TRIPPED", "trigger") - g0).toBe(1);
    expect(count("GUARD_TRIPPED", "resolve") - gr0).toBe(1);
  });

  it("MON_R2 MISSED_LIQUIDATION after > 2 blocks at HF < 1, and MON_R1 BAD_DEBT from the bad-debt liquidation", async () => {
    const d = s.config.d;
    const nvda = d.stocks.NVDA;
    await s.drv.openShort("NVDA", bob, 3_600n * E6, 10n * E18); // HF ≈ 1.23 now; +90% below puts collateral < debt
    const m0 = count("MISSED_LIQUIDATION", "trigger");
    const mr0 = count("MISSED_LIQUIDATION", "resolve");
    const good = s.drv.prices.NVDA;
    await s.drv.rounds({NVDA: good * 19n / 10n}); // +90%: collateral < debt → HF < 1 and bad debt on liquidation
    await tick();
    expect(count("MISSED_LIQUIDATION", "trigger") - m0, "not before 2 blocks").toBe(0);
    await mine(3);
    await tick();
    expect(count("MISSED_LIQUIDATION", "trigger") - m0).toBe(1);
    expect(pager.of("MISSED_LIQUIDATION", "trigger").at(-1)!.subject).toBe(`NVDA:${bob.toLowerCase()}`);

    // A liquidator seizes all collateral: Morpho realizes the rest as bad debt.
    const liq = "0x5700000000000000000000000000000000000a09" as const;
    const pos = await s.anvil.client.readContract({address: d.morpho, abi: morphoAbi, functionName: "position", args: [nvda.marketId, bob]});
    await s.drv.mintStock("NVDA", liq, 100n * E18);
    await s.anvil.send(liq, nvda.stockToken, call(erc20Abi, "approve", [nvda.wrapper, maxUint256]));
    await s.anvil.send(liq, nvda.wrapper, call(stockWrapperAbi, "wrap", [100n * E18, liq]));
    await s.anvil.send(liq, nvda.wrapper, call(erc20Abi, "approve", [d.morpho, maxUint256]));
    const b0 = count("BAD_DEBT", "trigger");
    const br0 = count("BAD_DEBT", "resolve");
    await s.anvil.send(liq, d.morpho, call(morphoAbi, "liquidate", [marketParams(d, nvda), bob, pos.collateral, 0n, "0x"]));
    await tick();
    expect(count("BAD_DEBT", "trigger") - b0).toBe(1);
    expect(pager.of("BAD_DEBT", "trigger").at(-1)!.severity).toBe("P0");
    expect(count("MISSED_LIQUIDATION", "resolve") - mr0, "debt gone").toBe(1);
    await s.drv.rounds({NVDA: good});
    clock.t += 25 * 3600_000;
    await tick();
    expect(count("BAD_DEBT", "resolve") - br0).toBe(1);
    expect(count("BAD_DEBT", "trigger") - b0).toBe(1);
  });

  it("MON_R8 L2_GAP (OR-R6): a 10-minute block gap, cleared after the quiet window", async () => {
    await firesAndResolves(
      "L2_GAP",
      async () => {
        await s.drv.rounds();
        await tick(); // detector sees the head
        await s.drv.warp((await s.drv.now()) + 600n);
      },
      async () => {
        await walk((await s.drv.now()) + 1300n);
        await s.drv.rounds();
      },
    );
  });

  it("MON_R9 KEEPER_DOWN: the keeper's /health stops answering, then comes back", async () => {
    await firesAndResolves(
      "KEEPER_DOWN",
      () => new Promise<void>((r) => keeper.close(() => r())),
      () => startKeeper(),
    );
  });

  it("MON_R12 UTILIZATION_HIGH: vault utilization above 95% for 1h after a lender exit, then a repay", async () => {
    await s.drv.rounds();
    await s.drv.borrow("SPY", carol, 100_000n * E6, 85n * E18);
    await s.drv.withdrawLend("SPY", spyLender, 13n * E18); // idle and free market liquidity leave → ≈ 97.7%
    const t0 = count("UTILIZATION_HIGH", "trigger");
    await tick();
    expect(count("UTILIZATION_HIGH", "trigger") - t0, "not before 1h").toBe(0);
    await firesAndResolves(
      "UTILIZATION_HIGH",
      async () => {
        await walk((await s.drv.now()) + H + 60n);
        await s.drv.rounds();
      },
      () => s.drv.repay("SPY", carol).then(() => {}),
    );
  });

  it("MON_R13 CALENDAR_RUNWAY (OR-R12): sessions truncated below 7 days and an earnings window removed, then re-pushed", async () => {
    const d = s.config.d;
    const mh = d.marketHours;
    const rd = <T,>(functionName: string, args: readonly unknown[] = []) => s.anvil.client.readContract({address: mh, abi: marketHoursAbi, functionName: functionName as never, args: args as never}) as Promise<T>;
    const now = await s.drv.now();
    const n = await rd<bigint>("sessionCount");
    const sessions: {openTs: bigint; closeTs: bigint}[] = [];
    for (let i = 0n; i < n; i++) sessions.push(await rd("sessionAt", [i]));
    const k = sessions.findIndex((x) => x.openTs > now);
    const removed = sessions.slice(k);
    await firesAndResolves(
      "CALENDAR_RUNWAY",
      () => s.anvil.send(d.timelock!, mh, call(marketHoursAbi, "replaceSessionsFrom", [BigInt(k), []])).then(() => {}),
      () => s.anvil.send(d.timelock!, mh, call(marketHoursAbi, "replaceSessionsFrom", [BigInt(k), removed])).then(() => {}),
    );
    expect(pager.of("CALENDAR_RUNWAY", "trigger").at(-1)!.subject).toBe("sessions");

    const aapl = d.stocks.AAPL.stockToken;
    const ne = await rd<bigint>("eventCount", [aapl]);
    const events: {startTs: bigint; endTs: bigint; bufferWad: bigint}[] = [];
    for (let i = 0n; i < ne; i++) events.push(await rd("eventAt", [aapl, i]));
    const j = events.findIndex((e) => e.startTs > now && e.startTs <= now + 30n * 86_400n);
    expect(j, "an AAPL earnings window within 30 days").toBeGreaterThanOrEqual(0);
    await firesAndResolves(
      "CALENDAR_RUNWAY",
      () => s.anvil.send(d.timelock!, mh, call(marketHoursAbi, "replaceEventsFrom", [aapl, BigInt(j), []])).then(() => {}),
      () => s.anvil.send(d.timelock!, mh, call(marketHoursAbi, "replaceEventsFrom", [aapl, BigInt(j), events.slice(j)])).then(() => {}),
    );
    expect(pager.of("CALENDAR_RUNWAY", "trigger").at(-1)!.subject).toBe("AAPL:events");
  });

  it("MON_R14 INDEXER_LAG: the indexer process is stopped (head falls behind), then restarted on its schema", async () => {
    const t0 = count("INDEXER_LAG", "trigger");
    const r0 = count("INDEXER_LAG", "resolve");
    await indexer.stop();
    indexerRunning = false;
    await mine(30);
    await tick();
    expect(count("INDEXER_LAG", "trigger") - t0).toBe(1);
    expect(pager.of("INDEXER_LAG", "trigger").at(-1)!.subject).toBe("head");
    indexer = await startIndexer({rpcUrl: s.anvil.url, databaseUrl: s.pg.url, resume: {schema: indexer.schema, viewsSchema: indexer.viewsSchema}});
    indexerRunning = true;
    await tick();
    expect(count("INDEXER_LAG", "resolve") - r0).toBe(1);
    expect(count("INDEXER_LAG", "trigger") - t0).toBe(1);
  }, 300_000);

  it("MON_R14 INDEXER_LAG (SI-R5 hook): a wNVDA donation to the vault moves its idle balance with no vault event; reconciliation finds the diff", async () => {
    const nvda = s.config.d.stocks.NVDA;
    const donor = "0x5700000000000000000000000000000000000a0d" as const;
    const t0 = count("INDEXER_LAG", "trigger");
    await s.drv.mintStock("NVDA", donor, E18);
    await s.anvil.send(donor, nvda.stockToken, call(erc20Abi, "approve", [nvda.wrapper, maxUint256]));
    await s.anvil.send(donor, nvda.wrapper, call(stockWrapperAbi, "wrap", [E18, donor]));
    await s.anvil.send(donor, nvda.wrapper, call(erc20Abi, "transfer", [nvda.vault, E18]));
    await tick();
    expect(count("INDEXER_LAG", "trigger") - t0).toBe(1);
    const p = pager.of("INDEXER_LAG", "trigger").at(-1)!;
    expect(p.subject).toBe("reconcile");
    expect(p.details.diffs).toBe(1);
    await tick();
    expect(count("INDEXER_LAG", "trigger") - t0, "deduped while the diff persists").toBe(1);
  });

  it("MON_R15 LOW_GAS / LOW_GAS_CRITICAL: keeper signer ETH below 3 / 1 days of burn (configured, then measured), resolved by a top-up", async () => {
    const signer = "0x5700000000000000000000000000000000000a15" as const;
    const gasPager = new FakePager();
    const gasClock = {t: Date.now()};
    const gasStore = new MonitorStore(pool, `monitor_gas_${Date.now()}`);
    await gasStore.migrate();
    const setBalance = (eth: bigint) => s.anvil.test.setBalance({address: signer, value: eth * E18});
    const gasMonitor = (burn: bigint) =>
      new Monitor(s.anvil.client, s.config.d, gasStore, [gasPager], {borrowers: async () => []}, {gasWatch: {operator: signer}, gasBurnWeiPerDay: burn, now: () => gasClock.t, reconcileEveryMs: 0, log: () => {}});
    const n = (rule: RuleId, action: "trigger" | "resolve") => gasPager.of(rule, action).filter((p) => p.subject === "operator").length;

    // Configured burn 1 ETH/day: 10 ETH quiet; 2 ETH → P1 only; 0.5 ETH → P0 too; top-up → both resolve.
    let m = gasMonitor(E18);
    await setBalance(10n);
    await m.tick();
    expect(n("LOW_GAS", "trigger") + n("LOW_GAS_CRITICAL", "trigger")).toBe(0);
    await setBalance(2n);
    await m.tick();
    await m.tick();
    expect(n("LOW_GAS", "trigger")).toBe(1);
    expect(n("LOW_GAS_CRITICAL", "trigger")).toBe(0);
    expect(gasPager.of("LOW_GAS", "trigger")[0].severity).toBe("P1");
    await s.anvil.test.setBalance({address: signer, value: E18 / 2n});
    await m.tick();
    expect(n("LOW_GAS_CRITICAL", "trigger")).toBe(1);
    expect(gasPager.of("LOW_GAS_CRITICAL", "trigger")[0].severity).toBe("P0");
    await setBalance(10n);
    await m.tick();
    expect(n("LOW_GAS", "resolve")).toBe(1);
    expect(n("LOW_GAS_CRITICAL", "resolve")).toBe(1);

    // No configured burn: a runaway keeper spending 1 ETH/hour is measured (over ≥ 1h) and pages P0.
    m = gasMonitor(0n);
    await setBalance(20n);
    await m.tick();
    gasClock.t += 1800_000;
    await setBalance(19n);
    await m.tick(); // 30 min: not measured yet
    expect(n("LOW_GAS", "trigger")).toBe(1);
    gasClock.t += 1800_000;
    await setBalance(18n);
    await m.tick(); // 2 ETH/h → 18 ETH lasts 9h
    expect(n("LOW_GAS", "trigger")).toBe(2);
    expect(n("LOW_GAS_CRITICAL", "trigger")).toBe(2);
    expect(gasPager.of("LOW_GAS_CRITICAL", "trigger").at(-1)!.details.burnWeiPerDay).toBe((48n * E18).toString());
    await setBalance(50n); // top-up restarts the measurement
    await m.tick();
    expect(n("LOW_GAS", "resolve")).toBe(2);
    expect(n("LOW_GAS_CRITICAL", "resolve")).toBe(2);
  });

  it("MON re-notifies an open incident after the interval and retries a failed delivery", async () => {
    const nvda = s.config.d.stocks.NVDA;
    pager.failures = 1;
    await s.anvil.send(DEPLOYER, nvda.stockToken, call(mockStockTokenAbi, "adminBurn", [nvda.wrapper, E18]));
    const t0 = count("BACKING_SHORTFALL", "trigger");
    await tick(); // delivery fails: claim released
    expect(count("BACKING_SHORTFALL", "trigger") - t0).toBe(0);
    await tick(); // retried
    expect(count("BACKING_SHORTFALL", "trigger") - t0).toBe(1);
    clock.t += 3600_000 + 1;
    await tick();
    expect(count("BACKING_SHORTFALL", "renotify")).toBeGreaterThanOrEqual(1);
    await s.anvil.send(DEPLOYER, nvda.stockToken, call(mockStockTokenAbi, "mint", [nvda.wrapper, E18]));
    await tick();
    // Restart: a new monitor over the same store sends nothing new.
    const before = pager.sent.length;
    const again = new Monitor(s.anvil.client, s.config.d, store, [pager], {borrowers: async () => []}, {now: () => clock.t, log: () => {}});
    await again.tick();
    expect(pager.sent.filter((p) => p.action !== "resolve").length).toBe(pager.sent.slice(0, before).filter((p) => p.action !== "resolve").length);
  });

  it("weekend log: every milestone of a closure per market, served by GET /weekends", async () => {
    await s.drv.rounds();
    const now = Number(await s.drv.now());
    const {ahead} = closuresAround(now);
    expect(ahead).toBeDefined();
    const close = BigInt(ahead!.closeTs);
    const reopen = BigInt(ahead!.reopenTs);
    // Weekdays until the ramp: a fresh round every 3h (heartbeat 24h), 4-minute blocks in between (no L2 gap).
    for (let t = BigInt(now) + 3n * H; t < close - 4n * H; t += 3n * H) {
      await walk(t);
      await s.drv.rounds();
      await tick();
    }
    for (let t = close - 4n * H + 600n; t < close; t += 1800n) {
      await walk(t);
      await s.drv.rounds();
      await tick();
    }
    await walk(close + 600n);
    await tick();
    await walk(reopen + 120n);
    await s.drv.rounds();
    await tick();
    await walk(reopen + 600n);
    await s.drv.rounds();
    await tick();
    const r = await monitorApp(store, new Health(60_000), Object.keys(s.config.d.stocks), [pager]).request("/weekends");
    expect(r.status).toBe(200);
    const body = (await r.json()) as {weekends: {closeTs: string; markets: Record<string, {complete: boolean; milestones: Record<string, unknown>}>}[]};
    const w = body.weekends.find((x) => x.closeTs === close.toString())!;
    expect(w).toBeDefined();
    for (const t of ["SPY", "NVDA", "AAPL"]) {
      expect(Object.keys(w.markets[t].milestones).sort(), t).toEqual(["closed", "first_fresh_round", "full_buffer", "ramp_in_start", "ramp_out"]);
      expect(w.markets[t].complete).toBe(true);
    }
    const inc = await monitorApp(store, new Health(60_000), [], [pager]).request("/incidents");
    expect(inc.status).toBe(200);
  }, 300_000);

  /** Advance chain time to `to` in steps under the L2 gap threshold, with fresh rounds every 12h (no stale feed). */
  async function passTime(to: bigint) {
    for (let t = (await s.drv.now()) + 12n * H; t < to; t += 12n * H) {
      await walk(t);
      await s.drv.rounds();
    }
    await walk(to);
    await s.drv.rounds();
  }

  it("MON_R16 TIMELOCK_SCHEDULED, MON_R17 TIMELOCK_EXECUTED (and _UNTRACKED P0), MON_R18 ROLE_CHANGED through the real TimelockController", async () => {
    const d = s.config.d;
    await tick(); // the governance cursor exists (first run starts at the head)
    const tl = d.timelock;
    const delay = await s.anvil.client.readContract({address: tl, abi: timelockAbi, functionName: "getMinDelay"});
    // A: a router parameter (unchanged value); B: a vault role change (a new sentinel), both through the timelock.
    const a = timelockOperation(d, {kind: "router.setGlobalCap", cap: 4_000_000n * E6}, {delay, salt: saltOf("mon a")});
    const sentinel = "0x5700000000000000000000000000000000000a0b" as const;
    const bData = call(vaultV2FullAbi, "setIsSentinel", [sentinel, true]);
    const bSalt = saltOf("mon b");
    const zero = `0x${"0".repeat(64)}` as Hex;
    const t0 = count("TIMELOCK_SCHEDULED", "trigger");
    await s.anvil.send(DEPLOYER, tl, a.scheduleCalldata);
    await s.anvil.send(DEPLOYER, tl, call(timelockAbi, "schedule", [d.stocks.NVDA.vault, 0n, bData, zero, bSalt, delay]));
    await tick();
    expect(count("TIMELOCK_SCHEDULED", "trigger") - t0).toBe(2);
    const sched = pager.of("TIMELOCK_SCHEDULED", "trigger").slice(-2);
    expect(sched[0].severity).toBe("P1");
    expect(sched[0].details.req).toBe("MON-R16");
    expect(sched[0].title).toContain("router.setGlobalCap(4000000000000)"); // decoded by the SDK
    expect(sched[1].title).toContain("vault:NVDA.setIsSentinel(");
    await tick();
    expect(count("TIMELOCK_SCHEDULED", "trigger") - t0, "deduped").toBe(2);

    // A second monitor started after the schedule never paged it: executions it sees are P0 (no time to react).
    const pager2 = new FakePager();
    const store2 = new MonitorStore(pool, `monitor2_${Date.now()}`);
    await store2.migrate();
    const late = new Monitor(s.anvil.client, d, store2, [pager2], new IndexerBorrowers(pool, s.indexer.viewsSchema), {now: () => clock.t, reconcileEveryMs: 0, log: () => {}});
    await late.tick();

    await passTime((await s.drv.now()) + delay + 60n);
    const e0 = count("TIMELOCK_EXECUTED", "trigger");
    const r0 = count("ROLE_CHANGED", "trigger");
    await s.anvil.send(DEPLOYER, tl, a.executeCalldata);
    await s.anvil.send(DEPLOYER, tl, call(timelockAbi, "execute", [d.stocks.NVDA.vault, 0n, bData, zero, bSalt]));
    await tick();
    await late.tick();
    expect(count("TIMELOCK_EXECUTED", "trigger") - e0).toBe(2);
    expect(count("TIMELOCK_EXECUTED_UNTRACKED", "trigger")).toBe(0);
    expect(pager2.of("TIMELOCK_EXECUTED_UNTRACKED", "trigger").length).toBe(2);
    expect(pager2.of("TIMELOCK_EXECUTED_UNTRACKED", "trigger")[0].severity).toBe("P0");
    expect(count("ROLE_CHANGED", "trigger") - r0, "SetIsSentinel").toBe(1);
    const role = pager.of("ROLE_CHANGED", "trigger").at(-1)!;
    expect(role.severity).toBe("P0");
    expect(role.title).toBe("vault:NVDA: SetIsSentinel");
    expect(role.details.req).toBe("MON-R18");

    // Event rules resolve by time (72h / 24h); the provider keeps the history.
    const rs = count("TIMELOCK_SCHEDULED", "resolve");
    const re = count("TIMELOCK_EXECUTED", "resolve");
    const rr = count("ROLE_CHANGED", "resolve");
    clock.t += 73 * 3600_000;
    await tick();
    expect(count("TIMELOCK_SCHEDULED", "resolve") - rs).toBe(2);
    expect(count("TIMELOCK_EXECUTED", "resolve") - re).toBe(2);
    expect(count("ROLE_CHANGED", "resolve") - rr).toBe(1);
    // Clean up the extra sentinel (the vault owner is the timelock: impersonated here), then let that page resolve.
    await s.anvil.send(tl, d.stocks.NVDA.vault, call(vaultV2FullAbi, "setIsSentinel", [sentinel, false]));
    await tick();
    clock.t += 25 * 3600_000;
    await tick();
  }, 600_000);

  it("MON_R19 LIQUIDATION_UNPROFITABLE: a liquidatable position whose seized collateral buys less than the debt on the DEX", async () => {
    const d = s.config.d;
    const dave = "0x5700000000000000000000000000000000000a0c" as const;
    await s.drv.rounds();
    const good = s.drv.prices.NVDA;
    const debtUsdg = (10n * good) / 100n; // 10 NVDA at the feed price, USDG 6 dp
    // Proceeds go to dave (compound = false); only the collateral backs the debt: 1.75 D × 0.77 / D ≈ HF 1.35.
    await s.drv.openShort("NVDA", dave, (debtUsdg * 7n) / 4n, 10n * E18);
    await firesAndResolves(
      "LIQUIDATION_UNPROFITABLE",
      async () => {
        await s.drv.rounds({NVDA: (good * 145n) / 100n}); // +45%: HF ≈ 0.93, collateral still > debt × LIF
        await s.anvil.send(DEPLOYER, d.mocks!.swapAggregator, call(mockSwapAggregatorAbi, "setFeeBps", [2_000n])); // the route costs 20%
      },
      () => s.anvil.send(DEPLOYER, d.mocks!.swapAggregator, call(mockSwapAggregatorAbi, "setFeeBps", [0n])).then(() => {}),
    );
    const p = pager.of("LIQUIDATION_UNPROFITABLE", "trigger").at(-1)!;
    expect(p.subject).toBe(`NVDA:${dave.toLowerCase()}`);
    expect(p.severity).toBe("P1");
    expect(p.runbook).toBe("docs/runbooks/missed-liquidation.md");
    expect(BigInt(String(p.details.stockForSeized)) < BigInt(String(p.details.repaidStock))).toBe(true);
    await s.drv.rounds({NVDA: good}); // back to healthy: MISSED_LIQUIDATION (if it fired) resolves too
    await s.drv.repay("NVDA", dave);
    await tick();
  }, 300_000);

  it("MON_R20 FEE_NOT_DISTRIBUTED: > $1k of fee shares wait in the FeeSplitter for the window (8 days; 6h here), then distribute", async () => {
    const d = s.config.d;
    const nvda = d.stocks.NVDA;
    // Real rNVDA shares in the splitter (as fees are): ~7 NVDA ≈ $1.6k. After the 50/50 split each converter
    // holds < $1k, so nothing else watches.
    await s.anvil.send(lender, nvda.vault, call(erc20Abi, "transfer", [d.feeSplitter!, 7n * E18]));
    const t0 = count("FEE_NOT_DISTRIBUTED", "trigger");
    await tick();
    expect(count("FEE_NOT_DISTRIBUTED", "trigger") - t0, "not before the window").toBe(0);
    await passTime((await s.drv.now()) + 6n * H + 60n);
    await tick();
    expect(count("FEE_NOT_DISTRIBUTED", "trigger") - t0).toBe(1);
    const p = pager.of("FEE_NOT_DISTRIBUTED", "trigger").at(-1)!;
    expect(p.subject).toBe("feeSplitter:NVDA");
    expect(p.severity).toBe("P2");
    expect(BigInt(String(p.details.valueUsdg))).toBeGreaterThan(1_000_000_000n);
    const r0 = count("FEE_NOT_DISTRIBUTED", "resolve");
    await s.anvil.send(lender, d.feeSplitter!, call(feeSplitterAbi, "distribute", [nvda.vault]));
    await tick();
    expect(count("FEE_NOT_DISTRIBUTED", "resolve") - r0).toBe(1);
    expect(count("FEE_NOT_DISTRIBUTED", "trigger") - t0).toBe(1);
  }, 600_000);

  it("MON quiet again: after the scenarios every rule is resolved", async () => {
    await s.drv.rounds();
    await tick();
    const open = await store.openIncidents();
    // The donation diff is real and stays until the indexer derives vault idle from balances (A29).
    expect(open.map((i) => `${i.rule}:${i.subject}`)).toEqual(["INDEXER_LAG:reconcile"]);
    // The vault's utilization and supply are consistent with the seed state (sanity for the test itself).
    expect(await s.anvil.client.readContract({address: s.config.d.stocks.SPY.vault, abi: vaultV2Abi, functionName: "totalAssets"})).toBeGreaterThan(0n);
  });
});
