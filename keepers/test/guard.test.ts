import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {mockStockTokenAbi, mockUniswapV3PoolAbi, stocklineOracleAbi} from "@stockline/sdk";
import {anvil as anvilChain} from "viem/chains";
import {startAnvil, type Anvil} from "./anvil.js";
import {call, DEPLOYER, freshRounds, WED} from "./helpers.js";
import {GuardKeeper, poolsFor, REASON} from "../src/guard/guard.js";
import {rpcUnlockedSender} from "../src/common/signer.js";

const NVDA_TICK = -222_132; // $225.66 in the stock/USDG mock pool (script/LocalMocks.sol)
const STALE = 8n;
const TOKEN_PAUSED = 128n;
/** Sat 2026-10-03 16:00Z: inside the weekend freeze (NVDA 48h buffer ~9.6% held). */
const SAT = WED + 3n * 86_400n;

describe("guard keeper on anvil with the task-7 deployment (OR-R31, OR-R32, OR-R6, D4)", () => {
  let a: Anvil;
  let keeper: GuardKeeper;

  const setTick = (tick: number) => a.send(DEPLOYER, a.d.mocks!.NVDA_USDG_pool, call(mockUniswapV3PoolAbi, "setTick", [tick]));
  const reasons = (fn: "latchedReasons" | "emittedReasons" | "guardReasons") =>
    a.client.readContract({address: a.d.stocks.NVDA.oracle, abi: stocklineOracleAbi, functionName: fn});
  const nvda = async () => (await keeper.tick()).find((x) => x.ticker === "NVDA")!;
  /** Advance in small steps (fresh rounds, no L2 gap) and tick. */
  async function advance(seconds: bigint, step = 240n) {
    const start = (await a.client.getBlock()).timestamp;
    for (let t = start + step; t <= start + seconds; t += step) {
      await freshRounds(a, t);
      await keeper.tick();
    }
  }

  beforeAll(async () => {
    a = await startAnvil();
    await freshRounds(a, WED);
    await a.test.impersonateAccount({address: a.d.roles.guardKeeper});
    keeper = new GuardKeeper(
      a.client,
      rpcUnlockedSender(a.client, a.url, anvilChain, a.d.roles.guardKeeper),
      a.d,
      poolsFor(a.d),
      undefined,
      undefined,
      (m) => process.env.GUARD_LOG && console.log(m),
    );
    await keeper.tick(); // remembers the current block for L2 gap detection
  });
  afterAll(() => a?.stop());

  it("no deviation at the feed price", async () => {
    await advance(1800n);
    const r = await nvda();
    expect(r.deviationWad! < 10n ** 15n).toBe(true);
    expect(r.thresholdWad).toBe(3n * 10n ** 16n);
    expect(await reasons("latchedReasons")).toBe(0n);
  });

  it("OR-R31: a 5% DEX premium held for the TWAP window trips DEVIATION; it clears after 30 min under", async () => {
    await setTick(NVDA_TICK + 488); // +5%
    await advance(1800n);
    expect((await reasons("latchedReasons")) & REASON.DEVIATION).toBe(REASON.DEVIATION);
    await setTick(NVDA_TICK);
    // The TWAP falls under 3% about 12 minutes later; clearing needs 30 continuous minutes under after that.
    await advance(1800n);
    expect((await reasons("latchedReasons")) & REASON.DEVIATION).toBe(REASON.DEVIATION);
    await advance(1200n);
    expect((await reasons("latchedReasons")) & REASON.DEVIATION).toBe(0n);
  });

  it("OR-R31 closed threshold is b_full + 3%: a 6% weekend premium is tolerated, 15% trips", async () => {
    await freshRounds(a, SAT - 86_400n * 2n + 3600n); // Thu, fresh
    await freshRounds(a, SAT - 86_400n + 3600n); // Fri 13:00 ET, last round before the freeze
    const fri = (await a.client.getBlock()).timestamp;
    // Walk into Saturday without feed rounds (the feed is frozen), in blocks a few minutes apart.
    for (let t = fri + 240n; t <= SAT; t += 240n) await a.setTime(t);
    await keeper.tick();
    await setTick(NVDA_TICK + 583); // +6%
    for (let t = SAT + 240n; t <= SAT + 1800n; t += 240n) await a.setTime(t);
    let r = await nvda();
    expect(r.thresholdWad! > 12n * 10n ** 16n).toBe(true);
    expect((await reasons("latchedReasons")) & REASON.DEVIATION).toBe(0n);
    await setTick(NVDA_TICK + 1398); // +15%
    for (let t = SAT + 2040n; t <= SAT + 3900n; t += 240n) await a.setTime(t);
    r = await nvda();
    expect((await reasons("latchedReasons")) & REASON.DEVIATION).toBe(REASON.DEVIATION);
    await setTick(NVDA_TICK);
  });

  it("OR-R32 / D4: the keeper pokes so staleness and an issuer pause are latched and emitted", async () => {
    const next = WED + 7n * 86_400n; // next Wednesday, open
    await freshRounds(a, next);
    await keeper.tick();
    // 25h without a round while open → STALE.
    for (let t = next + 240n; t < next + 25n * 3600n; t += 3600n) await a.setTime(t);
    await a.setTime(next + 25n * 3600n); // past heartbeat + grace (24h10m) with the session open
    await keeper.tick();
    expect((await reasons("emittedReasons")) & STALE).toBe(STALE);
    await freshRounds(a, next + 25n * 3600n + 60n);
    await keeper.tick();
    expect((await reasons("emittedReasons")) & STALE).toBe(0n);

    await a.send(DEPLOYER, a.d.stocks.NVDA.stockToken, call(mockStockTokenAbi, "pause"));
    await keeper.tick();
    expect((await reasons("emittedReasons")) & TOKEN_PAUSED).toBe(TOKEN_PAUSED);
    await a.send(DEPLOYER, a.d.stocks.NVDA.stockToken, call(mockStockTokenAbi, "unpause"));
    await keeper.tick();
    expect((await reasons("emittedReasons")) & TOKEN_PAUSED).toBe(0n);
  });

  it("OR-R6 keeper side: a 10-minute L2 block gap trips L2_GAP on every oracle; it clears after an hour", async () => {
    const t0 = (await a.client.getBlock()).timestamp;
    await a.setTime(t0 + 600n); // sequencer produced no block for 10 minutes
    await keeper.tick();
    for (const s of Object.values(a.d.stocks)) {
      const l = await a.client.readContract({address: s.oracle, abi: stocklineOracleAbi, functionName: "latchedReasons"});
      expect(l & REASON.L2_GAP).toBe(REASON.L2_GAP);
    }
    await advance(3600n, 240n);
    expect((await reasons("latchedReasons")) & REASON.L2_GAP).toBe(0n);
  });
});
