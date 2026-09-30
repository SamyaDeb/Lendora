import type pg from "pg";
import {formatUnits, type PublicClient} from "viem";
import {
  WAD,
  currentDebt,
  healthFactorAt,
  morphoAbi,
  nextClosure,
  nextEvent,
  readMarket,
  stockMarketState,
  type ChainDeployment, safeErrorLine} from "@lendora/sdk";
import type {Health} from "../common/health.js";
import type {SettingsStore, StoredSettings} from "./settings.js";
import type {Alert, Transport} from "./transports.js";

/**
 * APP-R8 alerts. Every tick (default 5 s; Robinhood Chain makes ~10 blocks/s) the watcher finds the borrow positions
 * of wallets with settings (indexer DB), reads the markets and positions from the chain, and computes with the SDK:
 * - `hf_below`: HF now < the wallet's threshold (latched until HF recovers 1% above it);
 * - `ramp_24h` / `ramp_4h`: 24h and 4h before a weekend or earnings ramp-in, when the HF at the full buffer < 1.2.
 * Each alert instance is claimed in Postgres before it is sent, so restarts and parallel ticks never duplicate it;
 * a failed delivery releases the claim and retries next tick. Dry run (the keeper default) logs instead of sending.
 */
export const RAMP_WARN_HF = 12n * 10n ** 17n;

export interface PositionSource {
  /** Borrow positions (ticker) of these wallets. */
  borrowers(addresses: string[]): Promise<{address: string; ticker: string}[]>;
}

/** Positions from the indexer's Postgres views (SI-R2 `position`). */
export class IndexerPositions implements PositionSource {
  constructor(
    private readonly pool: pg.Pool,
    private readonly schema: string,
  ) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) throw new Error(`bad schema ${schema}`);
  }
  async borrowers(addresses: string[]) {
    if (!addresses.length) return [];
    const {rows} = await this.pool.query(`select ticker, lower(account) as address from "${this.schema}".position where lower(account) = any($1) and borrow_shares > 0`, [addresses.map((a) => a.toLowerCase())]);
    return rows as {address: string; ticker: string}[];
  }
}

export interface WatcherOptions {
  dryRun: boolean;
  log?: (m: string) => void;
  health?: Health;
}

const f = (x: bigint) => Number(formatUnits(x, 18)).toFixed(3);

export class AlertWatcher {
  constructor(
    private readonly client: PublicClient,
    private readonly d: ChainDeployment,
    private readonly store: SettingsStore,
    private readonly positions: PositionSource,
    private readonly transports: Transport[],
    private readonly opts: WatcherOptions,
  ) {}

  private log(m: string) {
    (this.opts.log ?? console.log)(m);
  }

  async tick(): Promise<Alert[]> {
    const block = await this.client.getBlock();
    const subs = await this.store.all();
    const bySub = new Map(subs.map((s) => [s.address.toLowerCase(), s]));
    const out: Alert[] = [];
    const list = await this.positions.borrowers([...bySub.keys()]);
    const markets = new Map<string, Awaited<ReturnType<typeof readMarket>>>();
    for (const {address, ticker} of list) {
      const sub = bySub.get(address)!;
      if (!markets.has(ticker)) markets.set(ticker, await readMarket(this.client, this.d, ticker));
      const st = markets.get(ticker)!;
      const pos = await this.client.readContract({address: this.d.morpho, abi: morphoAbi, functionName: "position", args: [this.d.stocks[ticker].marketId, address as `0x${string}`], blockNumber: block.number});
      if (pos.borrowShares === 0n) continue;
      const p = {collateral: pos.collateral, borrowed: currentDebt(st, pos.borrowShares)};
      const sms = stockMarketState(st);
      const now = st.now;
      const hf = healthFactorAt(sms, p, now);
      const threshold = BigInt(Math.round(sub.settings.hfThreshold * 1e6)) * 10n ** 12n;
      const base = {address, ticker, block: block.number, blockTime: block.timestamp};

      if (hf < threshold) {
        const a: Alert = {
          ...base,
          kind: "hf_below",
          title: `Lendora: ${ticker} health factor ${f(hf)} is below your ${sub.settings.hfThreshold} alert`,
          body: `Your ${ticker} borrow has a health factor of ${f(hf)}. Liquidation happens at 1.00. Add collateral or repay to reduce the risk.`,
          data: {healthFactor: f(hf), threshold: sub.settings.hfThreshold},
        };
        if (await this.deliver(sub, a, "latched")) out.push(a);
      } else if (hf * 100n >= threshold * 101n) {
        await this.store.resetBelow(address, ticker);
      }

      if (!sub.settings.weekendWarning) continue;
      const windows: {rampStart: bigint; fullAt: bigint; what: string}[] = [];
      const nc = nextClosure(Number(now), st.params);
      if (nc?.open) windows.push({rampStart: BigInt(nc.rampStartTs), fullAt: BigInt(nc.closeTs), what: "the weekend/holiday close"});
      const ev = nextEvent(ticker, Number(now));
      if (ev) windows.push({rampStart: ev.startTs - st.params.rampIn, fullAt: ev.startTs, what: "the scheduled earnings release"});
      for (const w of windows) {
        const hfFull = healthFactorAt(sms, p, w.fullAt);
        if (hfFull >= RAMP_WARN_HF) continue;
        const kind = now >= w.rampStart - 4n * 3600n && now < w.rampStart ? "ramp_4h" : now >= w.rampStart - 24n * 3600n && now < w.rampStart - 4n * 3600n ? "ramp_24h" : undefined;
        if (!kind) continue;
        const hours = Number(w.rampStart - now) / 3600;
        const a: Alert = {
          ...base,
          kind,
          title: `Lendora: ${ticker} buffer ramps in ${hours.toFixed(1)}h; your health factor would be ${f(hfFull)}`,
          body: `Ahead of ${w.what}, the ${ticker} oracle buffer ramps in starting ${new Date(Number(w.rampStart) * 1000).toISOString()}. At the full buffer your health factor would be ${f(hfFull)} (liquidation at 1.00). Consider adding collateral or reducing the borrow.`,
          data: {healthFactorAtFullBuffer: f(hfFull), rampStart: Number(w.rampStart)},
        };
        if (await this.deliver(sub, a, w.rampStart.toString())) out.push(a);
      }
    }
    this.opts.health?.ok("alerts", block.number);
    return out;
  }

  /** Claim, then send on every configured channel; release the claim if nothing was delivered. */
  private async deliver(sub: StoredSettings, a: Alert, windowKey: string): Promise<boolean> {
    if (!(await this.store.claim(a.address, a.ticker, a.kind, windowKey, a.block))) return false;
    let delivered = 0;
    for (const t of this.transports) {
      const target = t.target(sub.settings);
      if (!target) continue;
      if (this.opts.dryRun) {
        this.log(`[alerts][dry-run] ${t.channel} ${a.kind} ${a.ticker} ${a.address}`);
        delivered++;
        continue;
      }
      try {
        await t.send(target, a);
        delivered++;
      } catch (e) {
        this.log(`[alerts] ${t.channel} ${a.kind} ${a.ticker} failed: ${safeErrorLine(e, process.env)}`);
      }
    }
    if (delivered === 0) {
      await this.store.release(a.address, a.ticker, a.kind, windowKey);
      return false;
    }
    this.log(`[alerts] ${a.kind} ${a.ticker} ${a.address} (block ${a.block})`);
    return true;
  }
}

export const ONE = WAD;
