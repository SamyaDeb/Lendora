import {describe, expect, it} from "vitest";
import type {Hex, PublicClient} from "viem";
import {MockVenueFunding} from "../src/dnRebalancer/funding.js";

const VENUE = "0x6dBFcC8bF4d176074774A410FDC4E604552f9898" as const;
const M = ["0x" + "11".repeat(32), "0x" + "22".repeat(32)] as Hex[];

/**
 * A chain of `head` blocks, one per 0.25 s (46630's pace), with a FundingApplied per market every 14,400 blocks
 * (hourly). getLogs refuses ranges over `limit` like a provider does; every call is counted.
 */
function fakeChain(head: bigint, limit: bigint) {
  const ts = (n: bigint) => 1_700_000_000n + n / 4n;
  const calls = {getLogs: [] as [bigint, bigint][], getBlock: 0};
  const client = {
    async getBlock(p?: {blockNumber?: bigint}) {
      const n = p?.blockNumber ?? head;
      if (p?.blockNumber !== undefined) calls.getBlock++;
      return {number: n, timestamp: ts(n)};
    },
    async getLogs(p: {fromBlock: bigint; toBlock: bigint}) {
      calls.getLogs.push([p.fromBlock, p.toBlock]);
      if (p.toBlock - p.fromBlock + 1n > limit) throw new Error(`eth_getLogs range over ${limit} blocks`);
      const out = [];
      for (let n = p.fromBlock + ((14_400n - (p.fromBlock % 14_400n)) % 14_400n); n <= p.toBlock; n += 14_400n)
        for (const m of M) out.push({blockNumber: n, args: {market: m, rateWad: m === M[0] ? 10n ** 14n : -(10n ** 14n), payment: 0n}});
      return out;
    },
  };
  return {client: client as unknown as PublicClient, calls, grow: (by: bigint) => (head += by)};
}

describe("MockVenueFunding on a long-lived testnet deployment (1.24M blocks, 46630)", () => {
  it("reads history in chunks under the provider's getLogs range, not one request from the start block", async () => {
    const c = fakeChain(1_240_000n, 50_000n);
    const f = new MockVenueFunding(c.client, VENUE, M, 0n);
    const h = await f.hourly(0, 240);
    expect(c.calls.getLogs.every(([a, b]) => b - a + 1n <= 50_000n)).toBe(true);
    // 240 hourly buckets over the last 10 days; the deployment is ~3.6 days old at 0.25 s blocks, so ~86 are filled.
    expect(h).toHaveLength(240);
    expect(h.filter((x) => x > 0).length).toBeGreaterThan(80);
    expect((await f.hourly(1, 240)).filter((x) => x < 0).length).toBeGreaterThan(80);
  });

  it("later ticks scan only the new blocks, and each log's block time is fetched once", async () => {
    const c = fakeChain(1_240_000n, 50_000n);
    const f = new MockVenueFunding(c.client, VENUE, M, 0n);
    await f.hourly(0, 240);
    await f.hourly(1, 240);
    const first = c.calls.getLogs.length;
    const blocks = c.calls.getBlock;
    c.grow(240n); // one minute later
    await f.hourly(0, 240);
    await f.hourly(1, 240);
    const later = c.calls.getLogs.slice(first);
    expect(later.length).toBe(1);
    expect(later[0][1] - later[0][0] + 1n).toBeLessThanOrEqual(240n);
    expect(c.calls.getBlock).toBe(blocks); // no new FundingApplied in that minute: no block lookups
  });

  it("a failed chunk is retried on the next tick from where it stopped (no gap, no double count)", async () => {
    const c = fakeChain(200_000n, 50_000n);
    const f = new MockVenueFunding(c.client, VENUE, M, 0n);
    const orig = c.client.getLogs.bind(c.client);
    let fail = true;
    (c.client as unknown as {getLogs: typeof orig}).getLogs = async (p) => {
      if (fail && (p as {fromBlock: bigint}).fromBlock >= 100_000n) throw new Error("429");
      return orig(p);
    };
    await expect(f.hourly(0, 240)).rejects.toThrow("429");
    fail = false;
    const h = await f.hourly(0, 240);
    const full = await new MockVenueFunding(fakeChain(200_000n, 50_000n).client, VENUE, M, 0n).hourly(0, 240);
    expect(h).toEqual(full);
  });
});
