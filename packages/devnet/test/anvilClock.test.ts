import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {startAnvil, type Anvil} from "../src/anvil.js";
import {SEED_TIMES} from "../src/scenario.js";

/**
 * The seed week is pinned to Wed 2026-09-30 (SEED_WED). anvil mined its first blocks at the wall clock, so from
 * 2026-09-30 15:00Z on, `setNextBlockTimestamp(SEED_TIMES.start)` was "lower than the previous block's timestamp" and
 * every seed-week suite failed. The fixture's chain runs on its own clock: it continues from the fixture's head.
 */
describe("anvil clock (fixture)", () => {
  let a: Anvil;
  beforeAll(async () => {
    a = await startAnvil();
  }, 60_000);
  afterAll(() => a?.stop());

  it("new blocks continue from the fixture's head, not the wall clock, so the seed week is always ahead", async () => {
    // A block mined at anvil's own "now" (a transaction before the first warp does the same).
    await (a.client.request as (r: {method: string; params: unknown[]}) => Promise<unknown>)({method: "evm_mine", params: []});
    const now = (await a.client.getBlock()).timestamp;
    expect(now).toBeLessThan(SEED_TIMES.start);
    await a.setTime(SEED_TIMES.start); // what the seed week does first
    expect((await a.client.getBlock()).timestamp).toBe(SEED_TIMES.start);
  });
});
