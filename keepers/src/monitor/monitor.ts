import type pg from "pg";
import type {Log, PublicClient} from "viem";
import {
  WAD,
  aggregatorV3Abi,
  collateralTokenAbi,
  feeConverterAbi,
  vaultV2FullAbi,
  deltaNeutralVaultAbi,
  navOracleAbi,
  perpAdapterAbi,
  strategyManagerAbi,
  currentDebt,
  erc20Abi,
  eventWindowsByTickerData,
  healthFactorAt,
  marketHoursAbi,
  morphoAbi,
  morphoEventsAbi,
  readMarket,
  safeErrorLine,
  stockMarketState,
  lendoraOracleAbi,
  stockWrapperAbi,
  type ChainDeployment,
  type MarketChainState,
} from "@lendora/sdk";
import type {Health} from "../common/health.js";
import {L2GapDetector} from "../common/l2gap.js";
import type {Page, PageAction, Pager, Severity} from "./pager.js";
import {FEED_REJECT_BITS, REASONS, RULES, reasonNames, type Observation, type RuleId} from "./rules.js";
import type {Incident, MonitorStore} from "./store.js";
import {closureForEvent, recordMilestones} from "./weekend.js";
import {GovernanceWatch} from "./governance.js";
import type {DexQuoter} from "./quoter.js";
import {planLiquidation} from "../liquidator/liquidator.js";

/**
 * Operator monitor (docs/prd/10 "Monitoring and paging", MON-R1…R20; LM-R8, LM-R33, CL-R6, OR-R6, LM-R31, SI-R5).
 * Read-only: it never sends a transaction, so it has no dry-run mode. Each tick it scans new Morpho and oracle events
 * (cursor in Postgres), reads every market, and turns what it sees into observations; the `MonitorStore` dedupes them
 * into incidents by `(rule, subject)`, re-notifies on an interval per severity and sends a resolve when the condition
 * clears. Restart-safe: all state that matters (incidents, duration watches, cursor, weekend log) is in Postgres.
 */
export interface BorrowerSource {
  /** Accounts with `borrowShares > 0`, per ticker. */
  borrowers(): Promise<{address: `0x${string}`; ticker: string}[]>;
  /** T9: blocks of every Morpho `SupplyCollateral` for `account` in `ticker`'s market (the caller is read from the log). */
  collateralSupplies?(ticker: string, account: string): Promise<bigint[]>;
}

/** Borrowers from the indexer's views (SI-R2 `position`). */
export class IndexerBorrowers implements BorrowerSource {
  constructor(
    private readonly pool: pg.Pool,
    private readonly schema: string,
  ) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) throw new Error(`bad schema ${schema}`);
  }
  async borrowers() {
    const {rows} = await this.pool.query(`select ticker, account from "${this.schema}".position where borrow_shares > 0`);
    return rows.map((r) => ({ticker: String(r.ticker), address: String(r.account) as `0x${string}`}));
  }
  async collateralSupplies(ticker: string, account: string): Promise<bigint[]> {
    const {rows} = await this.pool.query(
      `select distinct block_number from "${this.schema}".event_feed where ticker = $1 and type = 'supplyCollateral' and lower(account) = lower($2) order by block_number`,
      [ticker, account],
    );
    return rows.map((r) => BigInt(r.block_number));
  }
  /** SI-R3 indexed head (MON-R14). */
  async head(): Promise<bigint | undefined> {
    const {rows} = await this.pool.query(`select head_block from "${this.schema}".chain_head limit 1`);
    return rows[0] ? BigInt(rows[0].head_block) : undefined;
  }
}

export interface MonitorOptions {
  /** Re-notify an open incident after this long (ms), per severity. */
  renotifyMs: Record<Severity, number>;
  /** OR-R6 / MON-R8. */
  l2GapSec: bigint;
  l2ClearAfterSec: bigint;
  /** MON-R5: grace over the heartbeat (10 min). */
  staleGraceSec: bigint;
  /** MON-R9: keeper name → `/health` URL. */
  keepers: Record<string, string>;
  /** MON-R11: free liquidity at or below this (raw wSTOCK) counts as pulled; default = the allocator's minimum move
   * (1e15), below which it does not deallocate. */
  pullDust: bigint;
  /** MON-R12. */
  utilizationHighWad: bigint;
  /** MON-R13. */
  runwaySec: bigint;
  eventHorizonSec: bigint;
  /** MON-R14. */
  indexerLagBlocks: bigint;
  /** MON-R15: keeper signer name → address whose ETH pays for keeper transactions. */
  gasWatch: Record<string, `0x${string}`>;
  /** MON-R15: expected burn (wei/day) of the whole stack; the measured burn over the last day is used when higher. */
  gasBurnWeiPerDay: bigint;
  /** MON-R15: LOW_GAS (P1) below this many days of burn, LOW_GAS_CRITICAL (P0) below `gasCriticalDays`. */
  gasLowDays: number;
  gasCriticalDays: number;
  /** MON-R14 SI-R5 hook: runs the reconciliation (returns its diff count) at most every `reconcileEveryMs`. */
  reconcile?: () => Promise<{block: bigint; diffs: number}>;
  reconcileEveryMs: number;
  /** MON-R19: best-route quote for the liquidation profitability check (none: the rule is off). */
  quoter?: DexQuoter;
  /** MON-R20: a fee balance above this (USDG raw, oracle value) for `feeStuckForSec` (8 days) pages. */
  feeStuckUsdg: bigint;
  feeStuckForSec: bigint;
  /** MON-R21: DN delta band, bps of the sleeve's spot (DN-R2). */
  dnBandBps: bigint;
  /** MON-R22: margin floor, × maintenance (WAD) while open / closed (DN-R3; 08 weekend rule). */
  dnMarginOpenWad: bigint;
  dnMarginClosedWad: bigint;
  /** MON-R26 (T10): a withdrawal leaving HF at t + `bufferHorizonSec` below this pages (RT-R1's HF_MIN_OPEN). */
  bufferHfWad: bigint;
  bufferHorizonSec: bigint;
  /** First run without a cursor scans this many blocks back. */
  eventLookbackBlocks: bigint;
  logChunkBlocks: bigint;
  now: () => number;
  log: (m: string) => void;
}

export const defaultMonitorOptions: MonitorOptions = {
  renotifyMs: {P0: 15 * 60_000, P1: 60 * 60_000, P2: 6 * 3600_000},
  l2GapSec: 300n,
  l2ClearAfterSec: 3600n,
  staleGraceSec: 600n,
  keepers: {},
  pullDust: 10n ** 15n,
  utilizationHighWad: 95n * 10n ** 16n,
  runwaySec: 7n * 86_400n,
  eventHorizonSec: 30n * 86_400n,
  indexerLagBlocks: 20n,
  gasWatch: {},
  gasBurnWeiPerDay: 0n,
  gasLowDays: 3,
  gasCriticalDays: 1,
  reconcileEveryMs: 24 * 3600_000,
  feeStuckUsdg: 1_000_000_000n,
  feeStuckForSec: 8n * 86_400n,
  dnBandBps: 200n,
  dnMarginOpenWad: 2n * 10n ** 18n,
  dnMarginClosedWad: 3n * 10n ** 18n,
  bufferHfWad: 11n * 10n ** 17n,
  bufferHorizonSec: 86_400n,
  eventLookbackBlocks: 1000n,
  logChunkBlocks: 5000n,
  now: Date.now,
  log: console.log,
};

export interface TickResult {
  block: bigint;
  observations: Observation[];
  pages: Page[];
  weekend: string[];
}

const guardChanged = lendoraOracleAbi.find((x) => x.type === "event" && x.name === "GuardChanged")!;
const morphoLogEvents = morphoEventsAbi.filter((x) => x.type === "event" && (x.name === "Liquidate" || x.name === "Borrow" || x.name === "WithdrawCollateral"));
const supplyCollateralEvent = morphoEventsAbi.find((x) => x.type === "event" && x.name === "SupplyCollateral")!;

export class Monitor {
  private readonly o: MonitorOptions;
  private readonly l2: L2GapDetector;
  private readonly tickerByMarket = new Map<string, string>();
  private readonly tickerByOracle = new Map<string, string>();
  private lastReconcileAt = 0;
  /** MON-R15: balance samples per watched address over the last day (memory; a restart re-measures). */
  private readonly gasSamples = new Map<string, {at: number; balance: bigint}[]>();
  private readonly governance: GovernanceWatch;
  /** MON-R26: positions whose collateral was withdrawn since the last tick (subject → the withdrawal). */
  private readonly withdrawals = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly client: PublicClient,
    private readonly d: ChainDeployment,
    private readonly store: MonitorStore,
    private readonly pagers: Pager[],
    private readonly borrowers: BorrowerSource & {head?: () => Promise<bigint | undefined>},
    opts: Partial<MonitorOptions> = {},
    private readonly health?: Health,
  ) {
    this.o = {...defaultMonitorOptions, ...opts, renotifyMs: {...defaultMonitorOptions.renotifyMs, ...opts.renotifyMs}};
    this.l2 = new L2GapDetector(client, this.o.l2GapSec, this.o.l2ClearAfterSec);
    this.governance = new GovernanceWatch(client, d, store, this.o.logChunkBlocks);
    for (const [t, s] of Object.entries(d.stocks)) {
      this.tickerByMarket.set(s.marketId.toLowerCase(), t);
      this.tickerByOracle.set(s.oracle.toLowerCase(), t);
    }
  }

  private get tickers(): string[] {
    return Object.keys(this.d.stocks);
  }

  // ================================================================== tick

  async tick(): Promise<TickResult> {
    const block = await this.client.getBlock();
    const obs: Observation[] = [];
    const weekend: string[] = [];
    const section = async (name: string, f: () => Promise<void>) => {
      try {
        await f();
        this.health?.ok(name, block.number);
      } catch (e) {
        this.health?.fail(name, e);
        this.o.log(`[monitor] ${name} error: ${safeErrorLine(e, process.env)}`);
      }
    };

    await section("events", () => this.scanEvents(block.number, obs, weekend));
    const markets: MarketChainState[] = [];
    for (const t of this.tickers) {
      await section(`market:${t}`, async () => {
        const st = await readMarket(this.client, this.d, t);
        markets.push(st);
        await this.marketRules(st, obs);
        weekend.push(...(await recordMilestones(this.store, st)).map((k) => `${t}:${k}`));
      });
    }
    await section("positions", async () => {
      await this.missedLiquidations(markets, obs);
      await this.collateralBuffer(markets, obs); // MON-R26
    });
    await section("clusdg", () => this.clUsdgBacking(obs));
    await section("l2", async () => {
      const g = await this.l2.detect();
      obs.push({rule: "L2_GAP", subject: "chain", active: g.gap, title: "L2 block timestamp gap", details: {maxIntervalSec: g.maxIntervalSec.toString(), lastGapAt: this.l2.lastGap?.toString() ?? null, gapSec: this.o.l2GapSec.toString()}});
    });
    await section("keepers", () => this.keeperHealth(obs));
    await section("calendar", () => this.calendarRunway(block.timestamp, obs));
    await section("indexer", () => this.indexerLag(block.number, obs));
    await section("gas", () => this.gasRunway(obs));
    await section("governance", () => this.governance.scan(block.number, obs)); // MON-R16…R18
    await section("fees", () => this.feeBalances(obs)); // MON-R20
    await section("dn", () => this.dnVault(block.timestamp, obs)); // MON-R21…R25

    for (const o of obs) await this.apply(o, block.number, block.timestamp);
    const pages = await this.notify(block.number);
    return {block: block.number, observations: obs, pages, weekend};
  }

  // ================================================================== rules

  /** MON-R1 BAD_DEBT, MON-R10 DIRECT_BORROW (Morpho logs), MON-R6/R7 (GuardChanged), and weekend guard events. */
  private async scanEvents(head: bigint, obs: Observation[], weekend: string[]): Promise<void> {
    const from = ((await this.store.cursor("events")) ?? (head > this.o.eventLookbackBlocks ? head - this.o.eventLookbackBlocks : 0n)) + 1n;
    if (from > head) return;
    const oracles = this.tickers.map((t) => this.d.stocks[t].oracle);
    const blockTs = new Map<bigint, bigint>();
    const tsOf = async (n: bigint) => {
      if (!blockTs.has(n)) blockTs.set(n, (await this.client.getBlock({blockNumber: n})).timestamp);
      return blockTs.get(n)!;
    };
    for (let lo = from; lo <= head; lo += this.o.logChunkBlocks) {
      const hi = lo + this.o.logChunkBlocks - 1n < head ? lo + this.o.logChunkBlocks - 1n : head;
      const [morphoLogs, guardLogs] = await Promise.all([
        this.client.getLogs({address: this.d.morpho, events: morphoLogEvents, fromBlock: lo, toBlock: hi}),
        this.client.getLogs({address: oracles, event: guardChanged, fromBlock: lo, toBlock: hi}),
      ]);
      const all = [...morphoLogs, ...guardLogs].sort((a, b) => (a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : a.blockNumber! < b.blockNumber! ? -1 : 1)) as (Log & {eventName: string; args: Record<string, unknown>})[];
      for (const l of all) {
        const where = {tx: l.transactionHash, block: l.blockNumber!.toString(), logIndex: l.logIndex};
        if (l.eventName === "WithdrawCollateral") {
          const ticker = this.tickerByMarket.get(String(l.args.id).toLowerCase());
          if (!ticker) continue;
          const caller = String(l.args.caller).toLowerCase();
          this.withdrawals.set(`${ticker}:${String(l.args.onBehalf).toLowerCase()}`, {caller, path: caller === this.d.router!.toLowerCase() ? "router" : "direct", withdrawn: String(l.args.assets), ...where});
        } else if (l.eventName === "Liquidate" || l.eventName === "Borrow") {
          const ticker = this.tickerByMarket.get(String(l.args.id).toLowerCase());
          if (!ticker) continue;
          if (l.eventName === "Liquidate" && (l.args.badDebtAssets as bigint) > 0n) {
            obs.push({rule: "BAD_DEBT", subject: `${ticker}:${l.transactionHash}:${l.logIndex}`, active: true, title: `Bad debt realized in ${ticker}`, details: {ticker, borrower: l.args.borrower, badDebtAssets: String(l.args.badDebtAssets), seizedAssets: String(l.args.seizedAssets), ...where}});
          }
          if (l.eventName === "Borrow" && String(l.args.caller).toLowerCase() !== this.d.router!.toLowerCase()) {
            const suppliers = await this.collateralSuppliers(ticker, String(l.args.onBehalf));
            obs.push({rule: "DIRECT_BORROW", subject: `${ticker}:${String(l.args.onBehalf).toLowerCase()}`, active: true, title: `Direct Morpho borrow in ${ticker} (not through the router)`, details: {ticker, caller: l.args.caller, onBehalf: l.args.onBehalf, assets: String(l.args.assets), ...suppliers, ...where}});
          }
        } else {
          const ticker = this.tickerByOracle.get(l.address.toLowerCase())!;
          const reason = l.args.reason as bigint;
          const tripped = l.args.tripped as boolean;
          for (const name of reasonNames(reason)) {
            obs.push({rule: "GUARD_TRIPPED", subject: `${ticker}:${name}`, active: tripped, title: `${ticker} guard ${tripped ? "tripped" : "cleared"}: ${name}`, details: {ticker, reason: name, ...where}});
            if ((REASONS[name] & FEED_REJECT_BITS) !== 0n) obs.push({rule: "FEED_REJECTED", subject: `${ticker}:${name}`, active: tripped, title: `${ticker} feed rejected (${name})`, details: {ticker, reason: name, ...where}});
          }
          const ts = await tsOf(l.blockNumber!);
          const c = closureForEvent(Number(ts), Number((await this.rampIn(ticker)) ?? 4n * 3600n));
          if (c && (await this.store.logWeekend({ticker, closeTs: BigInt(c.closeTs), reopenTs: BigInt(c.reopenTs), kind: tripped ? "guard_trip" : "guard_clear", seq: `${l.transactionHash}:${l.logIndex}`, block: l.blockNumber!, ts, detail: {reasons: reasonNames(reason)}}))) {
            weekend.push(`${ticker}:${tripped ? "guard_trip" : "guard_clear"}`);
          }
        }
      }
      await this.store.setCursor("events", hi);
    }
  }

  private rampInCache = new Map<string, bigint>();
  private async rampIn(ticker: string): Promise<bigint | undefined> {
    if (!this.rampInCache.has(ticker)) {
      const p = await this.client.readContract({address: this.d.stocks[ticker].oracle, abi: lendoraOracleAbi, functionName: "params"});
      this.rampInCache.set(ticker, BigInt(p.rampIn));
    }
    return this.rampInCache.get(ticker);
  }

  /** MON-R3, R5, R6/R7 (state), R11, R12 for one market. */
  private async marketRules(st: MarketChainState, obs: Observation[]): Promise<void> {
    const t = st.ticker;
    const s = this.d.stocks[t];
    const [shortfall, params, round, open, windows] = await Promise.all([
      this.client.readContract({address: s.wrapper, abi: stockWrapperAbi, functionName: "backingShortfall"}),
      this.client.readContract({address: s.oracle, abi: lendoraOracleAbi, functionName: "params"}),
      this.client.readContract({address: s.feed, abi: aggregatorV3Abi, functionName: "latestRoundData"}),
      this.client.readContract({address: this.d.marketHours, abi: marketHoursAbi, functionName: "isOpen", args: [st.now]}),
      this.client.readContract({address: this.d.marketHours, abi: marketHoursAbi, functionName: "closureWindows", args: [st.now]}),
    ]);
    this.rampInCache.set(t, BigInt(params.rampIn));

    // MON-R3 (LM-R8): checked every tick (the monitor runs every few blocks).
    obs.push({rule: "BACKING_SHORTFALL", subject: t, active: shortfall > 0n, title: `${t} wrapper backing shortfall`, details: {ticker: t, shortfall: shortfall.toString(), wrapper: s.wrapper}});

    // MON-R5: open session and now − max(updatedAt, sessionOpen) > heartbeat + 10 min (raw feed, not the last good).
    const sessionOpen = windows[1];
    const updatedAt = round[3];
    const since = updatedAt > sessionOpen ? updatedAt : sessionOpen;
    const stale = open && st.now - since > BigInt(params.stockHeartbeat) + this.o.staleGraceSec;
    obs.push({rule: "ORACLE_STALE", subject: t, active: stale, title: `${t} feed stale while the session is open`, details: {ticker: t, feedUpdatedAt: updatedAt.toString(), sessionOpen: sessionOpen.toString(), ageSec: (st.now - since).toString(), heartbeat: params.stockHeartbeat}});

    // MON-R6/R7 state pass: the live reasons (catches trips no one poked yet, and clears).
    const names = reasonNames(st.guardReasons);
    const known = async (rule: RuleId) => [...(await this.store.openIncidents(rule)).map((i) => i.subject), ...(await this.store.watched(rule))].filter((x) => x.startsWith(`${t}:`));
    for (const subj of new Set([...(await known("GUARD_TRIPPED")), ...names.map((n) => `${t}:${n}`)])) {
      const name = subj.slice(t.length + 1);
      const active = names.includes(name);
      obs.push({rule: "GUARD_TRIPPED", subject: subj, active, title: `${t} guard ${active ? "tripped" : "cleared"}: ${name}`, details: {ticker: t, reason: name, reasons: names}});
    }
    const rejected = reasonNames(st.guardReasons & FEED_REJECT_BITS);
    for (const subj of new Set([...(await known("FEED_REJECTED")), ...rejected.map((n) => `${t}:${n}`)])) {
      const name = subj.slice(t.length + 1);
      obs.push({rule: "FEED_REJECTED", subject: subj, active: rejected.includes(name), title: `${t} feed rejected (${name})`, details: {ticker: t, reason: name}});
    }

    // MON-R11 (LM-R31): guard tripped and the vault still has withdrawable liquidity in the market.
    const marketFree = st.market.totalSupplyAssets - st.market.totalBorrowAssets;
    const free = st.adapterAssets < marketFree ? st.adapterAssets : marketFree;
    obs.push({rule: "PULL_NOT_EFFECTIVE", subject: t, active: st.guardReasons !== 0n && free > this.o.pullDust, title: `${t} guard tripped but liquidity was not pulled`, details: {ticker: t, freeLiquidity: free.toString(), reasons: names}});

    // MON-R12: vault-level utilization (07 `utilizationVault`) above 95% for 1h.
    const supply = st.market.totalSupplyAssets + st.vaultIdle;
    const u = supply > 0n ? (st.market.totalBorrowAssets * WAD) / supply : 0n;
    obs.push({rule: "UTILIZATION_HIGH", subject: t, active: u > this.o.utilizationHighWad, title: `${t} utilization above ${Number(this.o.utilizationHighWad) / 1e16}%`, details: {ticker: t, utilizationWad: u.toString()}});
  }

  /** MON-R2: HF < 1 (SDK `healthFactorAt` at the current buffer) for > 2 blocks, positions from the indexer. */
  private async missedLiquidations(markets: MarketChainState[], obs: Observation[]): Promise<void> {
    const byTicker = new Map(markets.map((m) => [m.ticker, m]));
    const subjects = new Set<string>();
    for (const b of await this.borrowers.borrowers()) subjects.add(`${b.ticker}:${b.address.toLowerCase()}`);
    for (const i of await this.store.openIncidents("MISSED_LIQUIDATION")) subjects.add(i.subject);
    for (const w of await this.store.watched("MISSED_LIQUIDATION")) subjects.add(w);
    for (const subj of subjects) {
      const [ticker, address] = subj.split(":") as [string, `0x${string}`];
      const st = byTicker.get(ticker);
      if (!st) continue;
      const pos = await this.client.readContract({address: this.d.morpho, abi: morphoAbi, functionName: "position", args: [this.d.stocks[ticker].marketId, address]});
      const borrowed = currentDebt(st, pos.borrowShares);
      const hf = borrowed === 0n ? null : healthFactorAt(stockMarketState(st), {collateral: pos.collateral, borrowed}, st.now);
      obs.push({rule: "MISSED_LIQUIDATION", subject: subj, active: hf !== null && hf < WAD, title: `${ticker} position ${address} liquidatable and not liquidated`, details: {ticker, borrower: address, hf: hf?.toString() ?? null, collateral: pos.collateral.toString(), borrowed: borrowed.toString()}});
      if (this.o.quoter) await this.liquidationProfit(subj, ticker, address, hf !== null && hf < WAD, pos, borrowed, obs);
    }
  }

  /**
   * T9 / residual (d): who supplied the borrower's collateral. `collateralSuppliers` are the callers of every Morpho
   * `SupplyCollateral` for the borrower other than the borrower and the router (an attested router entry is the
   * borrower's own); a never-attested borrower funded by another address shows that address here. Blocks come from the
   * indexer, the caller from one single-block `getLogs` each. A failed lookup never drops the page.
   */
  private async collateralSuppliers(ticker: string, borrower: string): Promise<Record<string, unknown>> {
    if (!this.borrowers.collateralSupplies) return {};
    try {
      const id = this.d.stocks[ticker].marketId;
      const router = this.d.router!.toLowerCase();
      const b = borrower.toLowerCase();
      const others = new Set<string>();
      let viaRouter = false;
      for (const block of await this.borrowers.collateralSupplies(ticker, borrower)) {
        const logs = await this.client.getLogs({address: this.d.morpho, event: supplyCollateralEvent, args: {id, onBehalf: borrower as `0x${string}`}, fromBlock: block, toBlock: block});
        for (const log of logs as unknown as {args: {caller: string}}[]) {
          const caller = log.args.caller.toLowerCase();
          if (caller === router) viaRouter = true;
          else if (caller !== b) others.add(caller);
        }
      }
      return {collateralSuppliers: [...others], collateralViaRouter: viaRouter};
    } catch (e) {
      return {collateralSuppliersError: safeErrorLine(e, process.env)};
    }
  }

  /**
   * MON-R26 (T10, residual (e)): after a collateral withdrawal, by the router or directly on Morpho, a position that
   * still has debt must hold HF >= 1.10 at t + 24h (the RT-R1 buffer). Evaluated on the position now (a later top-up
   * counts); a withdrawal's subject stays watched while its incident is open and resolves when the position recovers.
   */
  private async collateralBuffer(markets: MarketChainState[], obs: Observation[]): Promise<void> {
    const byTicker = new Map(markets.map((m) => [m.ticker, m]));
    const subjects = new Map(this.withdrawals);
    this.withdrawals.clear();
    for (const i of await this.store.openIncidents("COLLATERAL_BELOW_BUFFER")) if (!subjects.has(i.subject)) subjects.set(i.subject, {});
    for (const [subj, w] of subjects) {
      const [ticker, address] = subj.split(":") as [string, `0x${string}`];
      const st = byTicker.get(ticker);
      if (!st) {
        this.withdrawals.set(subj, w); // market read failed this tick: retry next tick
        continue;
      }
      const pos = await this.client.readContract({address: this.d.morpho, abi: morphoAbi, functionName: "position", args: [this.d.stocks[ticker].marketId, address]});
      const borrowed = currentDebt(st, pos.borrowShares);
      const state = stockMarketState(st);
      const hf24 = borrowed === 0n ? null : healthFactorAt(state, {collateral: pos.collateral, borrowed}, st.now + this.o.bufferHorizonSec);
      const hfNow = borrowed === 0n ? null : healthFactorAt(state, {collateral: pos.collateral, borrowed}, st.now);
      obs.push({
        rule: "COLLATERAL_BELOW_BUFFER",
        subject: subj,
        active: hf24 !== null && hf24 < this.o.bufferHfWad,
        title: `${ticker} collateral withdrawn below the 24h buffer by ${address}`,
        details: {ticker, borrower: address, hfNow: hfNow?.toString() ?? null, hfAt24h: hf24?.toString() ?? null, minHf: this.o.bufferHfWad.toString(), collateral: pos.collateral.toString(), borrowed: borrowed.toString(), ...w},
      });
    }
  }

  /**
   * MON-R19: a liquidatable position whose seized collateral (USDG, debt × LIF at the oracle price) buys less than the
   * debt on the best DEX route right now, i.e. liquidating loses money after the incentive: nobody will do it
   * (missed-liquidation runbook). Resolves when the route pays again or the position is gone.
   */
  private async liquidationProfit(subj: string, ticker: string, address: `0x${string}`, liquidatable: boolean, pos: {collateral: bigint; borrowShares: bigint}, borrowed: bigint, obs: Observation[]): Promise<void> {
    let active = false;
    let details: Record<string, unknown> = {ticker, borrower: address};
    if (liquidatable) {
      const s = this.d.stocks[ticker];
      const [price, answer] = await Promise.all([
        this.client.readContract({address: s.oracle, abi: lendoraOracleAbi, functionName: "price"}),
        this.client.readContract({address: s.oracle, abi: lendoraOracleAbi, functionName: "stockAnswer"}),
      ]);
      const plan = planLiquidation({borrower: address, collateral: pos.collateral, borrowShares: pos.borrowShares, borrowed}, price, BigInt(s.lltv), answer[0], 8, 0n);
      if (plan) {
        const out = await this.o.quoter!.stockOut(s.stockToken, this.d.usdg, plan.expectedSeized);
        active = out < plan.expectedRepaid;
        details = {...details, quoter: this.o.quoter!.name, seizedUsdg: plan.expectedSeized.toString(), repaidStock: plan.expectedRepaid.toString(), stockForSeized: out.toString(), badDebt: plan.badDebt};
      }
    }
    obs.push({rule: "LIQUIDATION_UNPROFITABLE", subject: subj, active, title: `${ticker} position ${address}: liquidation unprofitable at the current DEX price`, details});
  }

  /** MON-R20 (FE-R4): `rSTOCK` fee shares waiting in the splitter or a converter, valued at the oracle price. */
  private async feeBalances(obs: Observation[]): Promise<void> {
    const conv = this.d.treasuryConverter ?? this.d.backstopConverter;
    if (!this.d.feeSplitter || !conv) return;
    const holders: [string, `0x${string}`][] = [["feeSplitter", this.d.feeSplitter]];
    if (this.d.treasuryConverter) holders.push(["treasuryConverter", this.d.treasuryConverter]);
    if (this.d.backstopConverter) holders.push(["backstopConverter", this.d.backstopConverter]);
    for (const [t, s] of Object.entries(this.d.stocks)) {
      for (const [name, holder] of holders) {
        const shares = await this.client.readContract({address: s.vault, abi: erc20Abi, functionName: "balanceOf", args: [holder]});
        let value = 0n;
        if (shares > 0n) {
          const stock = await this.client.readContract({address: s.vault, abi: vaultV2FullAbi, functionName: "previewRedeem", args: [shares]});
          [value] = await this.client.readContract({address: conv, abi: feeConverterAbi, functionName: "quote", args: [s.vault, stock]});
        }
        obs.push({rule: "FEE_NOT_DISTRIBUTED", subject: `${name}:${t}`, active: value > this.o.feeStuckUsdg, title: `${t} fees above $${Number(this.o.feeStuckUsdg) / 1e6} waiting in ${name} for 8 days`, details: {ticker: t, holder: name, shares: shares.toString(), valueUsdg: value.toString()}});
      }
    }
  }

  /**
   * MON-R21…R25, delta-neutral vault (08): DN_DELTA_BREACH per sleeve (|spot − short| > band for 30 min),
   * DN_MARGIN_LOW (venue margin below 2× maintenance, 3× while closed), DN_NAV_STALE (the NAV can't mint or burn for
   * 5 min while the vault holds deposits), DN_QUEUE_OVERDUE (the queue head is past its promised settlement),
   * DN_KILL_SWITCH per sleeve (killed and still holding spot or a short: the unwind is in progress).
   */
  private async dnVault(now: bigint, obs: Observation[]): Promise<void> {
    const dn = this.d.dnVault;
    if (!dn) return;
    const rd = <T>(address: `0x${string}`, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => (this.client.readContract as (p: unknown) => Promise<T>)({address, abi, functionName, args});
    const [supply, fresh, open, bounds, n] = await Promise.all([
      rd<bigint>(dn.vault, erc20Abi, "totalSupply"),
      rd<boolean>(dn.navOracle, navOracleAbi, "fresh"),
      rd<boolean>(this.d.marketHours, marketHoursAbi, "isOpen", [now]),
      rd<readonly [bigint, bigint]>(dn.vault, deltaNeutralVaultAbi, "queueBounds"),
      rd<bigint>(dn.strategy, strategyManagerAbi, "sleeveCount"),
    ]);
    obs.push({rule: "DN_NAV_STALE", subject: "dnVault", active: supply > 0n && !fresh, title: "USDG Earn NAV is stale: no mint or burn (DN-R5)", details: {reportAge: (await rd<bigint>(dn.navOracle, navOracleAbi, "reportAge")).toString()}});
    let overdue = false;
    let head: {settleBy: bigint} | undefined;
    if (bounds[0] < bounds[1]) {
      head = await rd<{settleBy: bigint}>(dn.vault, deltaNeutralVaultAbi, "request", [bounds[0]]);
      overdue = BigInt(head.settleBy) <= now;
    }
    obs.push({rule: "DN_QUEUE_OVERDUE", subject: "dnVault", active: overdue, title: "USDG Earn withdrawal queue past its promised settlement (DN-R1)", details: {head: bounds[0].toString(), tail: bounds[1].toString(), settleBy: head ? String(head.settleBy) : null}});
    if (/^0x0{40}$/i.test(dn.perpAdapter)) return;
    // Margin: the venue's own view when it exposes one (mock venue), else skip (the rebalancer reads the report).
    try {
      const ratio = await rd<bigint>(dn.perpAdapter, [{type: "function", name: "marginRatio", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]}], "marginRatio");
      const floor = open ? this.o.dnMarginOpenWad : this.o.dnMarginClosedWad;
      obs.push({rule: "DN_MARGIN_LOW", subject: "venue", active: ratio < floor, title: `USDG Earn venue margin below ${Number(floor / 10n ** 16n) / 100}x maintenance (DN-R3)`, details: {ratioWad: ratio.toString(), floorWad: floor.toString(), open}});
    } catch {
      /* venue without an onchain margin view */
    }
    const last = await rd<{shortSizes: readonly bigint[]}>(dn.navOracle, navOracleAbi, "lastReport");
    for (let i = 0n; i < n; i++) {
      const sl = await rd<{perpMarket: `0x${string}`; active: boolean}>(dn.strategy, strategyManagerAbi, "sleeve", [i]);
      const spot = await rd<bigint>(dn.strategy, strategyManagerAbi, "spotUnits", [i]);
      const [readable, size] = await rd<readonly [boolean, bigint]>(dn.perpAdapter, perpAdapterAbi, "shortSize", [sl.perpMarket]);
      const short = readable ? size : (last.shortSizes[Number(i)] ?? 0n);
      const diff = spot > short ? spot - short : short - spot;
      const breach = sl.active && (spot > 0n ? diff * 10_000n > spot * this.o.dnBandBps : short > 0n);
      obs.push({rule: "DN_DELTA_BREACH", subject: `sleeve:${i}`, active: breach, title: `USDG Earn sleeve ${i}: net delta outside ±${Number(this.o.dnBandBps) / 100}% (DN-R2)`, details: {spot: spot.toString(), short: short.toString()}});
      obs.push({rule: "DN_KILL_SWITCH", subject: `sleeve:${i}`, active: !sl.active && (spot > 0n || short > 0n), title: `USDG Earn sleeve ${i} killed: unwinding to USDG (DN-R7)`, details: {spot: spot.toString(), short: short.toString()}});
    }
  }

  /** MON-R4 (CL-R6): USDG held by clUSDG ≥ clUSDG supply; fails on a Paxos freeze/wipe of the clUSDG address. */
  private async clUsdgBacking(obs: Observation[]): Promise<void> {
    const [bal, supply] = await Promise.all([
      this.client.readContract({address: this.d.usdg, abi: erc20Abi, functionName: "balanceOf", args: [this.d.clUSDG]}),
      this.client.readContract({address: this.d.clUSDG, abi: collateralTokenAbi, functionName: "totalSupply"}),
    ]);
    obs.push({rule: "CLUSDG_BACKING", subject: "clUSDG", active: bal < supply, title: "clUSDG under-backed (USDG freeze or wipe?)", details: {usdgBalance: bal.toString(), totalSupply: supply.toString()}});
  }

  /** MON-R9 (LM-R33): each keeper's `/health` answers 200 (the allocator's turns 503 after 5 min without a run). */
  private async keeperHealth(obs: Observation[]): Promise<void> {
    for (const [name, url] of Object.entries(this.o.keepers)) {
      let status = 0;
      let body: unknown;
      try {
        const r = await fetch(url, {signal: AbortSignal.timeout(5_000)});
        status = r.status;
        body = await r.json().catch(() => null);
      } catch (e) {
        body = safeErrorLine(e, process.env); // OFF-1
      }
      obs.push({rule: "KEEPER_DOWN", subject: name, active: status !== 200, title: `Keeper ${name} unhealthy`, details: {keeper: name, url, status, body}});
    }
  }

  /** MON-R13 (OR-R12): ≥ 7 days of sessions stored; every SDK earnings window within 30 days is onchain. */
  private async calendarRunway(now: bigint, obs: Observation[]): Promise<void> {
    const last = await this.client.readContract({address: this.d.marketHours, abi: marketHoursAbi, functionName: "lastSessionClose"});
    obs.push({rule: "CALENDAR_RUNWAY", subject: "sessions", active: last < now + this.o.runwaySec, title: "MarketHours session runway below 7 days", details: {lastSessionClose: last.toString(), runwaySec: (last > now ? last - now : 0n).toString()}});
    for (const t of this.tickers) {
      const due = (eventWindowsByTickerData[t] ?? []).filter((e) => e.startTs > now && e.startTs <= now + this.o.eventHorizonSec);
      const missing: string[] = [];
      for (const e of due) {
        const [latest] = await this.client.readContract({address: this.d.marketHours, abi: marketHoursAbi, functionName: "eventWindows", args: [this.d.stocks[t].stockToken, e.startTs]});
        if (BigInt(latest.startTs) !== e.startTs || BigInt(latest.endTs) !== e.endTs || BigInt(latest.bufferWad) !== e.bufferWad) missing.push(e.startTs.toString());
      }
      obs.push({rule: "CALENDAR_RUNWAY", subject: `${t}:events`, active: missing.length > 0, title: `${t} earnings window within 30 days not pushed`, details: {ticker: t, missingStartTs: missing}});
    }
  }

  /** MON-R14 (SI-R3, SI-R5): indexer head lag and the reconciliation result. */
  private async indexerLag(head: bigint, obs: Observation[]): Promise<void> {
    if (this.borrowers.head) {
      const indexed = await this.borrowers.head();
      const lag = indexed === undefined ? head : head - indexed;
      obs.push({rule: "INDEXER_LAG", subject: "head", active: lag > this.o.indexerLagBlocks, title: `Indexer ${lag} blocks behind`, details: {head: head.toString(), indexed: indexed?.toString() ?? null, lag: lag.toString()}});
    }
    if (this.o.reconcile && this.o.now() - this.lastReconcileAt >= this.o.reconcileEveryMs) {
      const r = await this.o.reconcile();
      this.lastReconcileAt = this.o.now();
      obs.push({rule: "INDEXER_LAG", subject: "reconcile", active: r.diffs > 0, title: `Indexer reconciliation: ${r.diffs} diff(s)`, details: {block: r.block.toString(), diffs: r.diffs}});
    }
  }

  /** MON-R15: days of ETH left per keeper signer at max(configured, measured) burn. A top-up restarts the measurement. */
  private async gasRunway(obs: Observation[]): Promise<void> {
    const DAY_MS = 86_400_000;
    const now = this.o.now();
    for (const [name, address] of Object.entries(this.o.gasWatch)) {
      const balance = await this.client.getBalance({address});
      let samples = (this.gasSamples.get(name) ?? []).filter((x) => now - x.at <= DAY_MS);
      if (samples.length > 0 && balance > samples[samples.length - 1].balance) samples = [];
      samples.push({at: now, balance});
      this.gasSamples.set(name, samples);
      const first = samples[0];
      const spanMs = now - first.at;
      // Measured only over ≥ 1h, so a single large test transaction does not read as a daily rate.
      const measured = spanMs >= 3_600_000 && first.balance > balance ? ((first.balance - balance) * BigInt(DAY_MS)) / BigInt(spanMs) : 0n;
      const burn = measured > this.o.gasBurnWeiPerDay ? measured : this.o.gasBurnWeiPerDay;
      const days = burn > 0n ? Number((balance * 1000n) / burn) / 1000 : Infinity;
      const details = {signer: name, address, balanceWei: balance.toString(), burnWeiPerDay: burn.toString(), measuredWeiPerDay: measured.toString(), daysLeft: Number.isFinite(days) ? days : null};
      obs.push({rule: "LOW_GAS", subject: name, active: days < this.o.gasLowDays, title: `Keeper signer ${name} has < ${this.o.gasLowDays} days of gas`, details});
      obs.push({rule: "LOW_GAS_CRITICAL", subject: name, active: days < this.o.gasCriticalDays, title: `Keeper signer ${name} has < ${this.o.gasCriticalDays} day of gas`, details});
    }
  }

  // ================================================================== incidents

  private async apply(o: Observation, block: bigint, ts: bigint): Promise<void> {
    const meta = RULES[o.rule];
    if (!o.active) {
      await this.store.unwatch(o.rule, o.subject);
      // Event rules resolve by time only; a later "inactive" state observation (e.g. guard cleared) still resolves.
      if (!meta.autoResolveSec) await this.store.resolve(o.rule, o.subject, block);
      return;
    }
    const forSec = o.rule === "FEE_NOT_DISTRIBUTED" ? this.o.feeStuckForSec : meta.forSec;
    if (meta.forBlocks !== undefined || forSec !== undefined) {
      const w = await this.store.watch(o.rule, o.subject, block, ts);
      if (block - w.sinceBlock < (meta.forBlocks ?? 0n) || ts - w.sinceTs < (forSec ?? 0n)) return;
    }
    const opened = await this.store.open({
      rule: o.rule,
      subject: o.subject,
      severity: meta.severity,
      title: o.title,
      details: {...o.details, req: meta.req},
      block,
      autoResolveAt: meta.autoResolveSec ? new Date(this.o.now() + meta.autoResolveSec * 1000) : undefined,
    });
    if (!opened) {
      const cur = await this.store.getOpen(o.rule, o.subject);
      if (cur) await this.store.touch(cur.id, {...cur.details, ...o.details, req: meta.req});
    }
  }

  private page(i: Incident, action: PageAction, block: bigint): Page {
    return {action, rule: i.rule, subject: i.subject, severity: i.severity, key: `${i.rule}:${i.subject}`, title: i.title, details: i.details, runbook: RULES[i.rule as RuleId]?.runbook, block, at: this.o.now()};
  }

  /** Delivers to every pager; true if at least one accepted it (providers dedupe by key, so a retry is harmless). */
  private async deliver(p: Page): Promise<boolean> {
    let ok = false;
    for (const pager of this.pagers) {
      try {
        await pager.send(p);
        ok = true;
      } catch (e) {
        this.o.log(`[monitor] ${pager.name} ${p.action} ${p.key}: ${safeErrorLine(e, process.env)}`);
      }
    }
    return ok;
  }

  /** Triggers and re-notifications (claimed first), auto-resolves, then owed resolve notifications. */
  private async notify(block: bigint): Promise<Page[]> {
    const sent: Page[] = [];
    const now = new Date(this.o.now());
    for (const i of await this.store.dueAutoResolve(now)) await this.store.resolve(i.rule, i.subject, block);
    for (const i of await this.store.openIncidents()) {
      const cutoff = new Date(now.getTime() - this.o.renotifyMs[i.severity]);
      if (!(await this.store.claimNotify(i.id, now, cutoff))) continue;
      const p = this.page(i, i.notifyCount === 0 ? "trigger" : "renotify", block);
      if (await this.deliver(p)) sent.push(p);
      else await this.store.releaseNotify(i.id);
    }
    for (const i of await this.store.pendingResolves()) {
      if (!(await this.store.markResolveNotified(i.id))) continue;
      if (i.notifyCount === 0) {
        const t = this.page(i, "trigger", block);
        if (!(await this.deliver(t))) {
          await this.store.unmarkResolveNotified(i.id);
          continue;
        }
        sent.push(t);
      }
      const p = this.page(i, "resolve", block);
      if (await this.deliver(p)) sent.push(p);
      else await this.store.unmarkResolveNotified(i.id);
    }
    for (const p of sent) this.o.log(`[monitor] ${p.severity} ${p.action} ${p.key}`);
    return sent;
  }
}
