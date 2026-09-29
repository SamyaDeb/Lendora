import {parseAbiItem, type Hex, type PublicClient} from "viem";
import type {FundingSource} from "./rebalancer.js";

const applied = parseAbiItem("event FundingApplied(bytes32 indexed market, int256 rateWad, int256 payment)");

/** The mock venue's funding periods (`FundingApplied`), bucketed per hour of chain time (anvil, testnet). */
export class MockVenueFunding implements FundingSource {
  constructor(
    private readonly client: PublicClient,
    private readonly venue: `0x${string}`,
    private readonly markets: Hex[],
    private readonly fromBlock = 0n,
  ) {}
  async hourly(sleeve: number, hours: number): Promise<number[]> {
    const head = await this.client.getBlock();
    const start = Number(head.timestamp) - hours * 3600;
    const logs = await this.client.getLogs({address: this.venue, event: applied, args: {market: this.markets[sleeve]}, fromBlock: this.fromBlock, toBlock: head.number});
    const buckets = new Array<number>(hours).fill(0);
    let seen = false;
    for (const l of logs) {
      const b = await this.client.getBlock({blockNumber: l.blockNumber!});
      const h = Math.floor((Number(b.timestamp) - start) / 3600);
      if (h < 0 || h >= hours) continue;
      buckets[h] += Number(l.args.rateWad!) / 1e18;
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
