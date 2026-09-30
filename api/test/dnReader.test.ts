import {describe, expect, it, vi} from "vitest";
import type {PublicClient} from "viem";
import type {ChainDeployment} from "@lendora/sdk";
import {DnReader} from "../src/vault.js";

/** OFF-22 (docs/audit/offchain-review.md): `/v1/vault/*` requests at a new block share one set of chain reads. */
describe("OFF-22 DnReader single flight", () => {
  it("OFF_22 ten concurrent requests at a new block read the chain once; the next block reads again", async () => {
    let head = 5n;
    const client = {getBlockNumber: async () => head} as unknown as PublicClient;
    const r = new DnReader(client, {} as ChainDeployment);
    const read = vi.spyOn(r as unknown as {read: (b: bigint) => Promise<unknown>}, "read").mockImplementation(async (b) => {
      await new Promise((ok) => setTimeout(ok, 20));
      const v = {block: b};
      (r as unknown as {cache: unknown}).cache = {at: Date.now(), v};
      return v;
    });
    const out = await Promise.all(Array.from({length: 10}, () => r.live()));
    expect(read).toHaveBeenCalledTimes(1);
    expect(new Set(out).size).toBe(1);
    await r.live(); // cached
    expect(read).toHaveBeenCalledTimes(1);
    head = 6n;
    await Promise.all([r.live(), r.live()]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("OFF_22 a failed read is not cached: the next request retries", async () => {
    const client = {getBlockNumber: async () => 7n} as unknown as PublicClient;
    const r = new DnReader(client, {} as ChainDeployment);
    let n = 0;
    vi.spyOn(r as unknown as {read: (b: bigint) => Promise<unknown>}, "read").mockImplementation(async () => {
      if (n++ === 0) throw new Error("rpc down");
      return {block: 7n};
    });
    await expect(r.live()).rejects.toThrow("rpc down");
    await expect(r.live()).resolves.toMatchObject({block: 7n});
  });
});
