import {parseAbiItem, type Hex, type PublicClient} from "viem";
import type {FundingSource} from "./rebalancer.js";

const applied = parseAbiItem("event FundingApplied(bytes32 indexed market, int256 rateWad, int256 payment)");

/**
 * The mock venue's funding periods (`FundingApplied`), bucketed per hour of chain time (anvil, testnet). The history is
 * scanned once in chunks of `maxRange` blocks, then only the new blocks each tick; each log's block time is read once.
 * Before (46630, 2026-09-30): every tick asked for every log since the start block (1.24M blocks) and a block per log,
 * per sleeve; when the public RPC was slow the fallback provider refused the range and every tick failed (T26).
 */
export class MockVenueFunding implements FundingSource {
  private scanned: bigint;
  private readonly periods: {market: string; ts: number; rate: number}[] = [];

  constructor(
    private readonly client: PublicClient,
    private readonly venue: `0x${string}`,
    private readonly markets: Hex[],
    fromBlock = 0n,
    private readonly maxRange = 50_000n,
  ) {
    this.scanned = fromBlock - 1n;
  }

  /** Scans (scanned, head] chunk by chunk; the cursor moves only past chunks that were read. */
  private async sync(head: bigint) {
    const times = new Map<bigint, number>();
    while (this.scanned < head) {
      const from = this.scanned + 1n;
      const to = from + this.maxRange - 1n < head ? from + this.maxRange - 1n : head;
      const logs = await this.client.getLogs({address: this.venue, event: applied, fromBlock: from, toBlock: to});
      const found: typeof this.periods = [];
      for (const l of logs) {
        const n = l.blockNumber!;
        if (!times.has(n)) times.set(n, Number((await this.client.getBlock({blockNumber: n})).timestamp));
        found.push({market: l.args.market!.toLowerCase(), ts: times.get(n)!, rate: Number(l.args.rateWad!) / 1e18});
      }
      this.periods.push(...found);
      this.scanned = to;
    }
  }

  async hourly(sleeve: number, hours: number): Promise<number[]> {
    const head = await this.client.getBlock();
    await this.sync(head.number);
    const start = Number(head.timestamp) - hours * 3600;
    const market = this.markets[sleeve].toLowerCase();
    const buckets = new Array<number>(hours).fill(0);
    let seen = false;
    for (const p of this.periods) {
      if (p.market !== market) continue;
      const h = Math.floor((p.ts - start) / 3600);
      if (h < 0 || h >= hours) continue;
      buckets[h] += p.rate;
      seen = true;
    }
    // No history at all (a fresh venue) is "insufficient history", never a kill.
    return seen ? buckets : [];
  }
}

/** Lighter's public hourly funding (`/api/v1/fundings`): `rate` is percent per hour, `direction` "long" = longs pay
 * shorts (task 13 finding). */
export class LighterFunding implements FundingSource {
  constructor(
    private readonly apiUrl: string,
    private readonly marketIds: number[],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async hourly(sleeve: number, hours: number): Promise<number[]> {
    const end = Math.floor(Date.now() / 1000);
    const url = `${this.apiUrl}/api/v1/fundings?market_id=${this.marketIds[sleeve]}&resolution=1h&start_timestamp=${end - hours * 3600}&end_timestamp=${end}&count_back=${hours}`;
    const r = await this.fetchImpl(url, {signal: AbortSignal.timeout(10_000)});
    if (!r.ok) throw new Error(`lighter fundings ${r.status}`);
    const j = (await r.json()) as {fundings?: {timestamp: number; rate: string; direction: string}[]};
    return (j.fundings ?? []).sort((a, b) => a.timestamp - b.timestamp).map((f) => (f.direction === "long" ? 1 : -1) * (Number(f.rate) / 100));
  }
}

/** Fixed series (tests, sim replays). */
export class StaticFunding implements FundingSource {
  constructor(private readonly series: number[][]) {}
  async hourly(sleeve: number, hours: number): Promise<number[]> {
    return (this.series[sleeve] ?? []).slice(-hours);
  }
}
