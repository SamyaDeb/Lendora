import {encodeFunctionData, type PublicClient} from "viem";
import {
  aggregatorV3Abi,
  marketHoursAbi,
  priceFromTick,
  stocklineOracleAbi,
  twapTick,
  uniswapV3PoolAbi,
  type ChainDeployment,
} from "@stockline/sdk";
import type {TxSender} from "../common/signer.js";
import type {Health} from "../common/health.js";

/** Oracle reason bits (StocklineOracleBase). */
export const REASON = {MANUAL: 1n, DEVIATION: 2n, L2_GAP: 4n} as const;

export interface GuardOptions {
  /** OR-R31: TWAP window. */
  twapSeconds: number;
  /** Deviation threshold while the feed session is open (3%). */
  openThresholdWad: bigint;
  /** Added to the buffer in force while closed (b_full + 3%). */
  closedMarginWad: bigint;
  /** Continuous time under the threshold before DEVIATION clears (30 min). */
  clearAfterSec: bigint;
  /** OR-R6 keeper side: consecutive L2 blocks further apart than this trip L2_GAP. */
  l2GapSec: bigint;
  /** L2_GAP clears after this long without a new gap. */
  l2ClearAfterSec: bigint;
}

export const defaultGuardOptions: GuardOptions = {
  twapSeconds: 1800,
  openThresholdWad: 3n * 10n ** 16n,
  closedMarginWad: 3n * 10n ** 16n,
  clearAfterSec: 1800n,
  l2GapSec: 300n,
  l2ClearAfterSec: 3600n,
};

export interface PoolRef {
  pool: `0x${string}`;
  /** Decimals of the stock and the quote (USDG) tokens. */
  stockDecimals: number;
  quoteDecimals: number;
}

export interface GuardTick {
  ticker: string;
  deviationWad?: bigint;
  thresholdWad?: bigint;
  actions: string[];
}

/**
 * Guard keeper (OR-R31, OR-R32, OR-R6 keeper side, D4). Memory between ticks is only an optimization (deviation
 * "under since" and the last seen block); after a restart it starts counting again, which can only keep the guard
 * tripped longer, never clear it early.
 */
export class GuardKeeper {
  private underSince = new Map<string, bigint>();
  private lastBlock?: {number: bigint; timestamp: bigint};
  private lastGapAt?: bigint;

  constructor(
    private readonly client: PublicClient,
    private readonly sender: TxSender,
    private readonly d: ChainDeployment,
    private readonly pools: Record<string, PoolRef>,
    private readonly opts: GuardOptions = defaultGuardOptions,
    private readonly health?: Health,
    private readonly log: (m: string) => void = console.log,
  ) {}

  /** DEX price (WAD USD) from the TWAP, and whether the stock is token0. */
  async dexPriceWad(ticker: string): Promise<bigint> {
    const ref = this.pools[ticker];
    const [token0, cums] = await Promise.all([
      this.client.readContract({address: ref.pool, abi: uniswapV3PoolAbi, functionName: "token0"}),
      this.client.readContract({address: ref.pool, abi: uniswapV3PoolAbi, functionName: "observe", args: [[this.opts.twapSeconds, 0]]}),
    ]);
    const tick = twapTick(cums[0][1], cums[0][0], this.opts.twapSeconds);
    const stockIsToken0 = token0.toLowerCase() === this.d.stocks[ticker].stockToken.toLowerCase();
    const price = priceFromTick(tick, stockIsToken0, ref.stockDecimals, ref.quoteDecimals);
    return BigInt(Math.round(price * 1e9)) * 10n ** 9n;
  }

  private async sendOracle(ticker: string, fn: "poke" | "trip" | "clear", args: bigint[], out: string[]): Promise<void> {
    const data = encodeFunctionData({abi: stocklineOracleAbi, functionName: fn, args: args as never});
    out.push(`${fn}${args.length ? `(${args[0]})` : ""}`);
    this.log(`[guard] ${ticker} ${fn} ${args.join(",")}`);
    await this.sender.send(this.d.stocks[ticker].oracle, data, `${ticker} ${fn}`);
  }

  async tickMarket(ticker: string, now: bigint, l2Gap: boolean): Promise<GuardTick> {
    const s = this.d.stocks[ticker];
    const c = this.client;
    const actions: string[] = [];
    const [latched, live, emitted, buffer, stockAnswer, feedRound, usdg, open] = await Promise.all([
      c.readContract({address: s.oracle, abi: stocklineOracleAbi, functionName: "latchedReasons"}),
      c.readContract({address: s.oracle, abi: stocklineOracleAbi, functionName: "liveReasons"}),
      c.readContract({address: s.oracle, abi: stocklineOracleAbi, functionName: "emittedReasons"}),
      c.readContract({address: s.oracle, abi: stocklineOracleAbi, functionName: "buffer"}),
      c.readContract({address: s.oracle, abi: stocklineOracleAbi, functionName: "stockAnswer"}),
      c.readContract({address: s.feed, abi: aggregatorV3Abi, functionName: "latestRoundData"}),
      c.readContract({address: s.oracle, abi: stocklineOracleAbi, functionName: "usdgAnswer"}),
      c.readContract({address: this.d.marketHours, abi: marketHoursAbi, functionName: "isOpen", args: [now]}),
    ]);

    // OR-R32 / D4: record new rounds and let onchain reasons (stale, sanity, issuer flags, multiplier, calendar)
    // latch and emit. poke() is permissionless and idempotent.
    const current = latched | live;
    if (current !== emitted || feedRound[3] > stockAnswer[1]) await this.sendOracle(ticker, "poke", [], actions);

    // OR-R6 keeper side.
    const hasGap = (latched & REASON.L2_GAP) !== 0n;
    if (l2Gap && !hasGap) await this.sendOracle(ticker, "trip", [REASON.L2_GAP], actions);
    if (!l2Gap && hasGap && this.lastGapAt !== undefined && now - this.lastGapAt >= this.opts.l2ClearAfterSec) {
      await this.sendOracle(ticker, "clear", [REASON.L2_GAP], actions);
    }

    // OR-R31 deviation: DEX TWAP (in USD via the USDG/USD feed) vs the feed price in use.
    if (!this.pools[ticker]) return {ticker, actions};
    const dexUsdg = await this.dexPriceWad(ticker);
    const dexUsd = (dexUsdg * usdg[0]) / 10n ** 8n;
    const feedUsd = stockAnswer[0] * 10n ** 10n;
    const dev = dexUsd > feedUsd ? ((dexUsd - feedUsd) * 10n ** 18n) / feedUsd : ((feedUsd - dexUsd) * 10n ** 18n) / feedUsd;
    const threshold = open ? this.opts.openThresholdWad : buffer + this.opts.closedMarginWad;
    const tripped = (latched & REASON.DEVIATION) !== 0n;
    if (dev > threshold) {
      this.underSince.delete(ticker);
      if (!tripped) await this.sendOracle(ticker, "trip", [REASON.DEVIATION], actions);
    } else if (tripped) {
      const since = this.underSince.get(ticker) ?? now;
      this.underSince.set(ticker, since);
      if (now - since >= this.opts.clearAfterSec) {
        await this.sendOracle(ticker, "clear", [REASON.DEVIATION], actions);
        this.underSince.delete(ticker);
      }
    }
    return {ticker, deviationWad: dev, thresholdWad: threshold, actions};
  }

  /** L2 block-timestamp gap since the last tick (scans at most `maxScan` blocks; otherwise checks the newest pair). */
  async detectL2Gap(maxScan = 2000n): Promise<{gap: boolean; now: bigint; number: bigint}> {
    const latest = await this.client.getBlock();
    let gap = false;
    const prev = this.lastBlock;
    if (prev && latest.number > prev.number && latest.timestamp - prev.timestamp >= this.opts.l2GapSec) {
      const from = latest.number - prev.number > maxScan ? latest.number - 1n : prev.number;
      let last = from === prev.number ? prev.timestamp : (await this.client.getBlock({blockNumber: from})).timestamp;
      for (let n = from + 1n; n <= latest.number; n++) {
        const b = n === latest.number ? latest : await this.client.getBlock({blockNumber: n});
        if (b.timestamp - last >= this.opts.l2GapSec) gap = true;
        last = b.timestamp;
      }
    }
    if (gap) this.lastGapAt = latest.timestamp;
    this.lastBlock = {number: latest.number, timestamp: latest.timestamp};
    const stillInGapWindow = this.lastGapAt !== undefined && latest.timestamp - this.lastGapAt < this.opts.l2ClearAfterSec;
    return {gap: gap || stillInGapWindow, now: latest.timestamp, number: latest.number};
  }

  async tick(): Promise<GuardTick[]> {
    const {gap, now, number} = await this.detectL2Gap();
    const out: GuardTick[] = [];
    for (const ticker of Object.keys(this.d.stocks)) {
      try {
        out.push(await this.tickMarket(ticker, now, gap));
        this.health?.ok(ticker, number);
      } catch (e) {
        this.health?.fail(ticker, e);
        this.log(`[guard] ${ticker} error: ${String(e)}`);
      }
    }
    return out;
  }
}

/** Pools the keeper reads: USDG pools from external-addresses.json on 4663, the mock pools on anvil. */
export function poolsFor(d: ChainDeployment, external?: {uniswapV3Pools: Record<string, `0x${string}`>}): Record<string, PoolRef> {
  const out: Record<string, PoolRef> = {};
  for (const t of Object.keys(d.stocks)) {
    const pool = d.mocks?.[`${t}_USDG_pool`] ?? external?.uniswapV3Pools[`${t}_USDG_500`];
    if (pool) out[t] = {pool, stockDecimals: 18, quoteDecimals: 6};
  }
  return out;
}
