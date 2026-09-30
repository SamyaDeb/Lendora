import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {createServer} from "node:http";
import {encodeFunctionData, maxUint256, type Hex} from "viem";
import {anvil as anvilChain} from "viem/chains";
import {deltaNeutralVaultAbi, erc20Abi, mockPerpVenueAbi, navOracleAbi, perpMarketId, strategyManagerAbi} from "@lendora/sdk";
import {ChainDriver} from "@lendora/devnet";
import {startAnvil, type Anvil} from "./anvil.js";
import {WED} from "./helpers.js";
import {DryRunSender, rpcUnlockedSender, rpcUnlockedTypedDataSigner} from "../src/common/signer.js";
import {LighterAccountSource, MockVenueSource, NavCosigner, NavReporter, sleeveMarkets, type Cosigner} from "../src/navReporter/navReporter.js";
import {defaultDnParams, DnRebalancer, killSwitch, mockDexSwapBuilder, MockVenueMargin, plan, type DnParams, type DnState, type FundingSource} from "../src/dnRebalancer/rebalancer.js";
import {MockVenueFunding, StaticFunding} from "../src/dnRebalancer/funding.js";

const E6 = 10n ** 6n;
const E18 = 10n ** 18n;
const OPERATOR = "0x976EA74026E726554dB657fA54763abd0C3a0aa9" as const; // anvil #6 (DeployLocal)
const NAV1 = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f" as const; // anvil #8
const NAV2 = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720" as const; // anvil #9
const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const alice = "0x00000000000000000000000000000000000e1a11" as const;

/** Phase 4 task 15 on anvil with the DeployLocal fixture (vault on the mock venue, dev caps): the NAV reporter and its
 * co-signer (DN-R4, R14), and the rebalancer (DN-R1, R2, R3, R7, R8) driving the real contracts. */
describe("DN keepers on anvil (task 15)", () => {
  let a: Anvil;
  let drv: ChainDriver;
  let markets: Hex[];
  const p: DnParams = {...defaultDnParams, entryChunkUsdg: 400_000n * E6, kill: {windowHours: 24, hours: 6, lendingApy: 0.02}};
  const dn = () => a.d.dnVault!;
  const rd = <T,>(address: `0x${string}`, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => (a.client.readContract as (x: unknown) => Promise<T>)({address, abi, functionName, args});
  const reporter = (cosigner?: Cosigner, sender = rpcUnlockedSender(a.client, a.url, anvilChain, NAV1)) =>
    new NavReporter(a.client, sender, rpcUnlockedTypedDataSigner(a.url, NAV1, 31337), a.d, new MockVenueSource(a.client, dn().perpAdapter, markets), 31337, cosigner, {everyMs: 60_000, moveBps: 50n}, undefined, () => {});
  const cosigner = () => new NavCosigner(a.client, rpcUnlockedTypedDataSigner(a.url, NAV2, 31337), a.d, new MockVenueSource(a.client, dn().perpAdapter, markets), 31337);
  const rebalancer = (sender = rpcUnlockedSender(a.client, a.url, anvilChain, OPERATOR), params = p, funding: FundingSource = new MockVenueFunding(a.client, dn().perpAdapter, markets)) =>
    new DnRebalancer(a.client, sender, a.d, mockDexSwapBuilder(a.d.mocks!.swapAggregator), new MockVenueMargin(a.client, dn().perpAdapter), funding, params, undefined, () => {});

  /** Reporter then rebalancer, `n` times; returns the share of sleeve-ticks in band. */
  /** One second later (a report needs a timestamp after the last one). */
  async function bump() {
    const b = await a.client.getBlock();
    await a.setTime(b.timestamp + 1n);
  }

  async function cycle(n: number, co?: Cosigner) {
    let inBand = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
      await bump();
      await reporter(co).tick();
      const r = await rebalancer().tick();
      expect(r.errors, JSON.stringify(r.actions.map((x) => x.kind))).toEqual([]);
      inBand += r.inBand.filter(Boolean).length;
      total += r.inBand.length;
    }
    await bump();
    await reporter(co).tick();
    return total ? inBand / total : 1;
  }

  async function depositFor(user: `0x${string}`, amount: bigint) {
    await drv.mintUsdg(user, amount);
    const att = await drv.attest(user);
    await a.send(user, a.d.usdg, encodeFunctionData({abi: erc20Abi, functionName: "approve", args: [dn().vault, maxUint256]}));
    await a.send(user, dn().vault, encodeFunctionData({abi: deltaNeutralVaultAbi, functionName: "deposit", args: [amount, user, att]}));
  }

  beforeAll(async () => {
    a = await startAnvil();
    drv = new ChainDriver(a, {log: () => {}});
    await drv.freshRounds(WED);
    markets = await sleeveMarkets(a.client, dn().strategy);
    // Other lenders in each rSTOCK vault, so DN-R8 lets the vault lend (worst case: ≤ others / 9).
    for (const t of drv.tickers) {
      await drv.mintStock(t, DEPLOYER, 20_000n * E18);
      await drv.lend(t, DEPLOYER, 20_000n * E18);
    }
    await a.send(DEPLOYER, a.d.usdg, encodeFunctionData({abi: erc20Abi, functionName: "transfer", args: [dn().perpAdapter, 0n]}));
  }, 300_000);
  afterAll(() => a?.stop());

  it("DN_R4 the reporter's typed data matches the oracle, and a dry run signs but sends nothing", async () => {
    const dry = new DryRunSender(NAV1, () => {});
    const r = await reporter(undefined, dry as never).tick();
    expect(r.submitted).toBe(true); // "submitted" through the dry sender
    expect(dry.sent).toHaveLength(1);
    expect((await rd<{timestamp: bigint}>(dn().navOracle, navOracleAbi, "lastReport")).timestamp).toBe(0n);
    const live = await reporter().tick();
    expect(live).toMatchObject({submitted: true, signers: 1});
    expect(await rd<boolean>(dn().navOracle, navOracleAbi, "fresh")).toBe(true);
  });

  it("DN_R1_R2_R8 the rebalancer builds the 08 structure from a deposit and keeps delta in band", async () => {
    await depositFor(alice, 1_000_000n * E6);
    const share = await cycle(6);
    const nav = await rd<bigint>(dn().vault, deltaNeutralVaultAbi, "totalAssets");
    expect(Number(nav)).toBeGreaterThan(0.98 * 1e12); // entry costs only (the mock DEX pays the feed price)
    for (let i = 0; i < 3; i++) {
      const spot = await rd<bigint>(dn().strategy, strategyManagerAbi, "spotUnits", [BigInt(i)]);
      const [, short] = await rd<readonly [boolean, bigint]>(dn().perpAdapter, mockPerpVenueAbi, "shortSize", [markets[i]]);
      expect(spot, `sleeve ${i} built`).toBeGreaterThan(0n);
      expect(short).toBe(spot);
      const lent = await rd<bigint>(dn().strategy, strategyManagerAbi, "lentUnits", [BigInt(i)]);
      expect(lent * 10_000n).toBeLessThanOrEqual(spot * 9_000n + 10_000n); // maxLendBps
    }
    const spyValue = await rd<bigint>(dn().strategy, strategyManagerAbi, "quote", [0n, await rd<bigint>(dn().strategy, strategyManagerAbi, "spotUnits", [0n])]);
    expect(Number(spyValue)).toBeGreaterThan(0.95 * 0.5 * 0.75 * 1e12 * 0.97); // SPY 50% × 0.95 × L/(L+1)
    expect(share).toBe(1);
    expect(await rd<bigint>(dn().vault, deltaNeutralVaultAbi, "idleAssets")).toBeGreaterThanOrEqual(45_000n * E6); // the cash buffer
  }, 600_000);

  it("DN_R2_R14 price moves: NAV stays hedged between reports, the rebalancer keeps the band", async () => {
    const nav0 = await rd<bigint>(dn().vault, deltaNeutralVaultAbi, "totalAssets");
    await drv.rounds({NVDA: (drv.prices.NVDA * 108n) / 100n, SPY: (drv.prices.SPY * 97n) / 100n});
    const nav1 = await rd<bigint>(dn().vault, deltaNeutralVaultAbi, "totalAssets");
    expect(Math.abs(Number(nav1 - nav0)) / Number(nav0)).toBeLessThan(0.002);
    expect(await cycle(3)).toBe(1);
  }, 600_000);

  it("DN_R4 a report moving NAV > 1% needs the independent co-signer, who checks it against its own read", async () => {
    // Venue funding credits the account: a > 1% move in one report.
    await a.send(DEPLOYER, dn().perpAdapter, encodeFunctionData({abi: mockPerpVenueAbi, functionName: "applyFunding", args: [markets[0], 5n * 10n ** 16n]}));
    await bump();
    const alone = await reporter().tick();
    expect(alone.submitted).toBe(false);
    expect(alone.reason).toMatch(/second signer is required/);
    // A co-signer refuses a report that disagrees with its own read of the venue.
    const r = await reporter().build();
    await expect(cosigner().cosign({...r, equity: r.equity + 5_000n * E6})).rejects.toThrow(/differs/);
    const ok = await reporter(cosigner()).tick();
    expect(ok).toMatchObject({submitted: true, signers: 2});
  }, 300_000);

  it("DN_R3 +30–50% moves top the margin up from cash, then spot, back to ≥ 2× maintenance", async () => {
    await drv.rounds({NVDA: (drv.prices.NVDA * 150n) / 100n, AAPL: (drv.prices.AAPL * 150n) / 100n, SPY: (drv.prices.SPY * 130n) / 100n});
    const before = await rd<bigint>(dn().perpAdapter, mockPerpVenueAbi, "marginRatio");
    await cycle(3, cosigner());
    const after = await rd<bigint>(dn().perpAdapter, mockPerpVenueAbi, "marginRatio");
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThanOrEqual(2n * E18);
  }, 600_000);

  it("DN_R1 a withdrawal larger than the buffer is queued, the rebalancer raises cash and settles it, the claim pays", async () => {
    const shares = await rd<bigint>(dn().vault, erc20Abi, "balanceOf", [alice]);
    await a.send(alice, dn().vault, encodeFunctionData({abi: deltaNeutralVaultAbi, functionName: "requestRedeem", args: [shares / 2n, alice, alice]}));
    await cycle(3, cosigner());
    const [head, tail] = await rd<readonly [bigint, bigint]>(dn().vault, deltaNeutralVaultAbi, "queueBounds");
    expect(head).toBe(tail);
    const req = await rd<{assets: bigint; status: number}>(dn().vault, deltaNeutralVaultAbi, "request", [head - 1n]);
    expect(req.status).toBe(2); // Claimable
    const before = await rd<bigint>(a.d.usdg, erc20Abi, "balanceOf", [alice]);
    await a.send(alice, dn().vault, encodeFunctionData({abi: deltaNeutralVaultAbi, functionName: "claim", args: [head - 1n]}));
    expect(await rd<bigint>(a.d.usdg, erc20Abi, "balanceOf", [alice])).toBe(before + req.assets);
  }, 600_000);

  it("08 weekend rule: no spot trades while the feed is closed (margin above 1.5×)", async () => {
    await drv.freshRounds(WED + 3n * 86_400n); // Saturday 12:00 ET
    await a.send(DEPLOYER, dn().perpAdapter, encodeFunctionData({abi: mockPerpVenueAbi, functionName: "applyFunding", args: [markets[1], 0n]}));
    await reporter(cosigner()).tick();
    const dry = new DryRunSender(OPERATOR, () => {});
    await rebalancer(dry as never).tick();
    expect(dry.sent.map((s) => s.label).filter((l) => /^(buy|sell)/.test(l))).toEqual([]);
  }, 300_000);

  it("DN_R7 the funding kill switch kills and unwinds a sleeve", async () => {
    await drv.freshRounds(WED + 5n * 86_400n); // Monday 12:00 ET
    const neg = Array.from({length: 40}, () => -1 / 8760); // −100% APR
    const funding = new StaticFunding([[], neg, []]);
    await reporter(cosigner()).tick();
    const r = await rebalancer(rpcUnlockedSender(a.client, a.url, anvilChain, OPERATOR), p, funding).tick();
    expect(r.actions.map((x) => x.kind)).toContain("kill");
    expect((await rd<{active: boolean}>(dn().strategy, strategyManagerAbi, "sleeve", [1n])).active).toBe(false);
    const [, short] = await rd<readonly [boolean, bigint]>(dn().perpAdapter, mockPerpVenueAbi, "shortSize", [perpMarketId("NVDA")]);
    expect(short).toBe(0n);
    expect(await rd<bigint>(dn().strategy, strategyManagerAbi, "spotUnits", [1n])).toBe(0n);
  }, 300_000);
});

describe("DN planner and sources (pure)", () => {
  const sleeve = (spot: bigint, short: bigint) => ({id: 0, active: true, capUsdg: 10n ** 13n, maxLendBps: 9000n, stockToken: "0x1" as const, wrapper: "0x2" as const, rVault: "0x3" as const, unitValue: 200n * E6, spot, lent: 0n, wrapped: spot, loose: 0n, rShares: 0n, short, others: 0n, rIdle: 0n, guardClear: true});
  const base = (o: Partial<DnState> = {}): DnState => ({now: 0n, open: true, regular: true, fresh: true, paused: false, nav: 10n ** 12n, idle: 5n * 10n ** 10n, bufferBps: 500n, stratUsdg: 0n, queuedAssets: 0n, headOverdue: false, headPayable: false, margin: {equity: 10n ** 11n, maintenance: 10n ** 9n}, pending: 0n, sleeves: [sleeve(1000n * E18, 1000n * E18)], kill: [false], ...o});

  it("T23 DN_R8 unlend asks the lending vault for no more than it holds idle (no liquidity adapter)", () => {
    // 46630: the strategy was the NVDA vault's only lender (others 0, so the DN-R8 cap is 0), 90% of the vault was in
    // the Morpho market; unlending everything reverted every tick and the rebalancer did nothing else (KEEPER_DOWN).
    const lent = {...sleeve(1000n * E18, 1000n * E18), lent: 100n * E18, rShares: 100n * E18, others: 0n};
    const unlend = (rIdle: bigint) => plan(base({sleeves: [{...lent, rIdle}]}), defaultDnParams, false).find((x) => x.kind === "unlend") as {units: bigint} | undefined;
    expect(unlend(10n * E18)?.units).toBe(10n * E18);
    expect(unlend(0n)).toBeUndefined();
    expect(unlend(500n * E18)?.units).toBe(100n * E18); // enough idle: the whole excess
  });

  it("DN_R2 realigns a short outside the band, and exactly once per session", () => {
    expect(plan(base({sleeves: [sleeve(1000n * E18, 970n * E18)]}), defaultDnParams, false).map((x) => x.kind)).toContain("alignShort");
    expect(plan(base({sleeves: [sleeve(1000n * E18, 990n * E18)]}), defaultDnParams, false).map((x) => x.kind)).not.toContain("alignShort");
    expect(plan(base({sleeves: [sleeve(1000n * E18, 990n * E18)]}), defaultDnParams, true).map((x) => x.kind)).toContain("alignShort");
  });

  it("DN_R3 margin below 3× while closed is topped up from cash; below 1.5× spot may be sold even on a weekend", () => {
    const low = base({open: false, idle: 10n ** 11n, margin: {equity: 25n * 10n ** 8n, maintenance: 10n ** 9n}});
    expect(plan(low, defaultDnParams, false).find((x) => x.kind === "topUpMargin")).toBeDefined();
    const crash = base({open: false, idle: 5n * 10n ** 10n, margin: {equity: 14n * 10n ** 8n, maintenance: 10n ** 9n}});
    const kinds = plan(crash, defaultDnParams, false).map((x) => x.kind);
    expect(kinds).toContain("reduce");
    const calm = base({open: false});
    expect(plan(calm, defaultDnParams, false).map((x) => x.kind)).not.toContain("reduce");
  });

  it("DN_R8 lends only up to the worst-case redeemable share of the rSTOCK vault", () => {
    const s = sleeve(1000n * E18, 1000n * E18);
    const none = plan(base({sleeves: [{...s, others: 0n}]}), defaultDnParams, false);
    expect(none.find((x) => x.kind === "lend")).toBeUndefined();
    const some = plan(base({sleeves: [{...s, others: 900n * E18}]}), defaultDnParams, false).find((x) => x.kind === "lend");
    expect(some && "wrapped" in some ? some.wrapped : 0n).toBe(100n * E18); // others / 9
  });

  it("DN_R7_R13 kill switch needs the full history and a sustained breach", () => {
    const k = {windowHours: 24, hours: 6, lendingApy: 0.02};
    expect(killSwitch(Array(29).fill(-1 / 8760), k)).toBe(false); // insufficient history
    expect(killSwitch(Array(30).fill(-1 / 8760), k)).toBe(true);
    expect(killSwitch([...Array(29).fill(-1 / 8760), 5 / 8760 * 24], k)).toBe(false);
    expect(killSwitch(Array(30).fill(0.01 / 8760), k)).toBe(false);
  });

  it("A41 Lighter account source: equity = collateral + unrealized PnL; shorts are sign -1 (fake server)", async () => {
    const srv = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({accounts: [{collateral: "1000.50", positions: [{market_id: 26, sign: -1, position: "2.5", unrealized_pnl: "-10.25"}, {market_id: 15, sign: 1, position: "1", unrealized_pnl: "3"}]}]}));
    });
    await new Promise<void>((r) => srv.listen(0, r));
    const port = (srv.address() as {port: number}).port;
    const src = new LighterAccountSource(`http://127.0.0.1:${port}`, "0x0000000000000000000000000000000000000001", [26, 15, 10]);
    const read = await src.read();
    srv.close();
    expect(read.equity).toBe(993_250_000n);
    expect(read.sizes).toEqual([25n * 10n ** 17n, 0n, 0n]);
  });
});
