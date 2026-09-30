import {afterAll, beforeAll, describe, expect, it} from "vitest";
import pg from "pg";
import {
  adaptiveCurveBorrowRate,
  erc20Abi,
  expectedMarketBalances,
  marketHoursAbi,
  morphoAbi,
  lendoraOracleAbi,
} from "@lendora/sdk";
import {ChainDriver, seedWeek, startAnvil, startPostgres, USERS, type Anvil, type SeedResult, type Service} from "@lendora/devnet";
import {startIndexer, type IndexerHandle} from "../lib/harness.js";
import {ConsolePager, reconcile} from "../lib/reconcile.js";

/**
 * SI-R1…R5 on anvil: the seed week (every router flow, a weekend, a liquidation, a guard trip, a multiplier change)
 * is indexed and the indexed state equals onchain state at the same block.
 */
describe("indexer on anvil with the seed week (SI-R1…R5)", () => {
  let a: Anvil;
  let drv: ChainDriver;
  let seed: SeedResult;
  let pgs: Service;
  let pool: pg.Pool;
  let idx: IndexerHandle;
  let head: bigint;
  const t = (name: string) => `"${idx.viewsSchema}".${name}`;

  beforeAll(async () => {
    a = await startAnvil();
    drv = new ChainDriver(a);
    seed = await seedWeek(drv);
    pgs = await startPostgres();
    pool = new pg.Pool({connectionString: pgs.url});
    idx = await startIndexer({rpcUrl: a.url, databaseUrl: pgs.url});
    head = await a.client.getBlockNumber();
    await idx.waitForBlock(head);
  }, 300_000);

  afterAll(async () => {
    await idx?.stop();
    await pool?.end();
    pgs?.stop();
    a?.stop();
  });

  it("SI_R4 backfill of the seed week completes (measured, recorded in 07 status)", () => {
    console.log(`[SI-R4] backfill of ${head} blocks: ${idx.backfillMs} ms`);
    expect(idx.backfillMs).toBeLessThan(120_000);
  });

  it("SI_R1_R5 indexed Morpho totals, IRM rate, vault idle and every position equal onchain reads at the head", async () => {
    const r = await reconcile({pool, schema: idx.viewsSchema, client: a.client, d: a.d, pager: new ConsolePager()});
    expect(r.block).toBe(head);
    expect(r.checked).toBeGreaterThan(40);
    expect(r.diffs).toEqual([]);
  });

  it("SI_R5 a tampered total is detected and paged", async () => {
    // Ponder's tables carry live-query triggers; tamper with a copy instead.
    const copy = `${idx.viewsSchema}_tamper`;
    await pool.query(`create schema "${copy}"`);
    for (const table of ["market", "position", "chain_head"]) await pool.query(`create table "${copy}".${table} as select * from ${t(table)}`);
    await pool.query(`update "${copy}".market set total_borrow_assets = total_borrow_assets + 2 where ticker = 'NVDA'`);
    const pager = new ConsolePager();
    const r = await reconcile({pool, schema: copy, client: a.client, d: a.d, pager});
    expect(r.diffs.map((d) => `${d.ticker}.${d.field}`)).toEqual(["NVDA.totalBorrowAssets"]);
    expect(pager.sent).toHaveLength(1);
    expect(pager.sent[0].severity).toBe("P2");
  });

  it("SI_R2 the latest snapshot per stock equals SDK math on onchain reads at its block", async () => {
    const {rows} = await pool.query(`select * from ${t("latest_snapshot")} order by ticker`);
    expect(rows.map((r) => r.ticker)).toEqual(["AAPL", "NVDA", "SPY"]);
    for (const row of rows) {
      const s = a.d.stocks[row.ticker];
      const blockNumber = BigInt(row.block_number);
      expect(blockNumber).toBe(head);
      const block = await a.client.getBlock({blockNumber});
      const [mk, buffer, reasons, open, idle, rat] = await Promise.all([
        a.client.readContract({address: a.d.morpho, abi: morphoAbi, functionName: "market", args: [s.marketId], blockNumber}),
        a.client.readContract({address: s.oracle, abi: lendoraOracleAbi, functionName: "buffer", blockNumber}),
        a.client.readContract({address: s.oracle, abi: lendoraOracleAbi, functionName: "guardReasons", blockNumber}),
        a.client.readContract({address: a.d.marketHours, abi: marketHoursAbi, functionName: "isOpen", args: [block.timestamp], blockNumber}),
        a.client.readContract({address: s.wrapper, abi: erc20Abi, functionName: "balanceOf", args: [s.vault], blockNumber}),
        a.client.readContract({
          address: a.d.adaptiveCurveIrm,
          abi: [{type: "function", name: "rateAtTarget", stateMutability: "view", inputs: [{type: "bytes32"}], outputs: [{type: "int256"}]}] as const,
          functionName: "rateAtTarget",
          args: [s.marketId],
          blockNumber,
        }),
      ]);
      const accrued = expectedMarketBalances(mk, BigInt(rat), block.timestamp);
      expect(BigInt(row.total_supply_assets), row.ticker).toBe(accrued.totalSupplyAssets);
      expect(BigInt(row.total_borrow_assets), row.ticker).toBe(accrued.totalBorrowAssets);
      expect(BigInt(row.borrow_rate_per_sec), row.ticker).toBe(adaptiveCurveBorrowRate(mk, BigInt(rat), block.timestamp).avgRate);
      expect(BigInt(row.vault_idle), row.ticker).toBe(idle);
      expect(BigInt(row.buffer_wad), row.ticker).toBe(buffer);
      expect(BigInt(row.guard_reasons), row.ticker).toBe(reasons);
      expect(row.market_open, row.ticker).toBe(open);
    }
  });

  it("SI_R2 snapshots every block where state changed, with 1m / 1h / 1d rollups and flows", async () => {
    const liq = seed.events.find((e) => e.kind === "liquidate")!;
    const {rows: snap} = await pool.query(`select kind from ${t("snapshot")} where ticker = 'NVDA' and block_number = $1`, [liq.block.toString()]);
    expect(snap).toEqual([{kind: "event"}]);
    for (const interval of ["1m", "1h", "1d"]) {
      const {rows} = await pool.query(`select count(*)::int as n from ${t("rollup")} where ticker = 'NVDA' and interval = $1`, [interval]);
      expect(rows[0].n, interval).toBeGreaterThan(0);
    }
    // Flows: the sum of Borrow events per ticker equals the sum of the 1d borrow buckets.
    const {rows: flows} = await pool.query(
      `select f.ticker, f.total, e.total as events from (select ticker, sum(borrow_flow) total from ${t("flow_bucket")} where interval = '1d' group by ticker) f
       join (select ticker, sum(assets) total from ${t("event_feed")} where type = 'borrow' group by ticker) e using (ticker)`,
    );
    expect(flows.length).toBe(3);
    for (const f of flows) expect(f.total).toBe(f.events);
  });

  it("SI_R2 status history: the weekend shows closed, the guard trip shows guard_tripped, and they clear", async () => {
    const q = async (ticker: string, ts: bigint) =>
      (await pool.query(`select market_status from ${t("snapshot")} where ticker = $1 and timestamp <= $2 order by block_number desc limit 1`, [ticker, ts.toString()])).rows[0]
        ?.market_status;
    expect(await q("NVDA", seed.times.close + 6n * 3600n)).toBe("closed"); // first weekend block is close + 3h
    expect(await q("NVDA", seed.times.rampStart + 3600n)).toBe("ramping");
    // The trip, the rejected borrow and the clear share one timestamp (anvil), so look up by block.
    const trip = seed.events.find((e) => e.kind === "guardian:trip")!;
    const {rows} = await pool.query(`select market_status from ${t("snapshot")} where ticker = 'AAPL' and block_number = $1`, [trip.block.toString()]);
    expect(rows[0].market_status).toBe("guard_tripped");
    expect(await q("AAPL", seed.times.end)).toBe("open");
  });

  it("SI_R2 event feed carries the router and Morpho events with the liquidation details", async () => {
    const {rows} = await pool.query(`select type, account, data from ${t("event_feed")} where ticker = 'NVDA' and type = 'liquidate'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].account.toLowerCase()).toBe(USERS.erin.toLowerCase());
    expect(BigInt(rows[0].data.seizedAssets)).toBeGreaterThan(0n);
    const {rows: types} = await pool.query(`select distinct type from ${t("event_feed")}`);
    const set = new Set(types.map((r) => r.type));
    for (const k of ["lend", "withdrawLend", "openShort", "closeShort", "routerBorrow", "routerRepay", "borrow", "repay", "guard", "multiplier", "deposit", "allocate", "deallocate"]) {
      expect(set.has(k), k).toBe(true);
    }
  });

  it("SI_R2 borrowers and daysToCover are derived (mock DEX volume on anvil)", async () => {
    const {rows} = await pool.query(`select ticker, borrowers, days_to_cover from ${t("latest_snapshot")} order by ticker`);
    const by = Object.fromEntries(rows.map((r) => [r.ticker, r]));
    expect(by.NVDA.borrowers).toBe(2); // Erin (after partial liquidation) and Heidi
    expect(by.AAPL.borrowers).toBe(0);
    expect(by.NVDA.days_to_cover).toBeGreaterThan(0);
  });

  it("SI_R3 confirmed flag inputs: head, safe and finalized come from the chain's tags", async () => {
    await drv.poke(["SPY"]); // one more block so the head row refreshes with current tags
    const h = await a.client.getBlockNumber();
    await idx.waitForBlock(h);
    await new Promise((r) => setTimeout(r, 2_500)); // tags are refreshed at most every 2 s
    await drv.poke(["SPY"]);
    const h2 = await a.client.getBlockNumber();
    await idx.waitForBlock(h2);
    const {rows} = await pool.query(`select * from ${t("chain_head")}`);
    const [safe, finalized] = await Promise.all([a.client.getBlock({blockTag: "safe"}), a.client.getBlock({blockTag: "finalized"})]);
    expect(BigInt(rows[0].head_block)).toBe(h2);
    expect(BigInt(rows[0].finalized_block)).toBeLessThanOrEqual(BigInt(rows[0].safe_block));
    expect(BigInt(rows[0].safe_block)).toBeLessThanOrEqual(h2);
    expect(BigInt(rows[0].finalized_block)).toBeGreaterThan(0n);
    expect(finalized.number! - BigInt(rows[0].finalized_block)).toBeLessThan(5n);
    expect(safe.number! - BigInt(rows[0].safe_block)).toBeLessThan(5n);
  });

  it("SI_R4 head lag at ~10 blocks/s (Robinhood Chain cadence) is measured; p95 ≤ 3 blocks", async () => {
    const lags: number[] = [];
    let running = true;
    const sampler = (async () => {
      while (running) {
        const [chain, indexed] = await Promise.all([a.client.getBlockNumber(), idx.indexedBlock()]);
        lags.push(Number(chain - indexed));
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    for (let i = 0; i < 60; i++) {
      await drv.poke(["NVDA"]); // one block each
      await new Promise((r) => setTimeout(r, 100));
    }
    await idx.waitForBlock(await a.client.getBlockNumber());
    running = false;
    await sampler;
    lags.sort((x, y) => x - y);
    const p95 = lags[Math.floor(lags.length * 0.95)];
    const p50 = lags[Math.floor(lags.length * 0.5)];
    console.log(`[SI-R4] head lag over ${lags.length} samples: p50 ${p50}, p95 ${p95}, max ${lags[lags.length - 1]} blocks`);
    expect(p95).toBeLessThanOrEqual(3);
  });
});
