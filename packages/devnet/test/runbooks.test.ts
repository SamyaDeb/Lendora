import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {encodeFunctionData, getAddress, type Hex} from "viem";
import {
  marketHoursAbi,
  mockStockTokenAbi,
  morphoAbi,
  saltOf,
  stocklineOracleAbi,
  stocklineRouterAbi,
  timelockAbi,
  timelockOperation,
  type TimelockAction,
  erc20Abi,
  feeSplitterAbi,
  vaultCuratorOperation,
  vaultV2FullAbi,
} from "@stockline/sdk";
import {DEPLOYER, startAnvil, type Anvil} from "../src/anvil.js";
import {ChainDriver, GUARD} from "../src/driver.js";
import {SEED_WED} from "../src/scenario.js";

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const call = (abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => (encodeFunctionData as (p: unknown) => Hex)({abi, functionName, args});

/**
 * Runbook rehearsals on anvil (remediation task 4): every onchain step the P0/P1 runbooks prescribe, run against the
 * deployed contracts, with owner actions going through the real TimelockController using the calldata from
 * `packages/sdk/scripts/timelockCalldata.ts` (owner multisig = the DeployLocal deployer). Detection of each incident is
 * rehearsed by the monitor test (keepers/test/monitor.test.ts).
 */
describe("runbook rehearsals on anvil (docs/runbooks)", () => {
  let a: Anvil;
  let drv: ChainDriver;
  const borrower = "0x5700000000000000000000000000000000000b01" as const;
  const lender = "0x5700000000000000000000000000000000000b02" as const;
  const reasons = (t: string) => a.client.readContract({address: a.d.stocks[t].oracle, abi: stocklineOracleAbi, functionName: "guardReasons"});

  /** schedule → wait the min delay (fresh rounds keep the feeds alive) → execute, as the runbooks say. */
  async function governed(action: TimelockAction, label: string) {
    const tl = a.d.timelock;
    const delay = await a.client.readContract({address: tl, abi: timelockAbi, functionName: "getMinDelay"});
    const op = timelockOperation(a.d, action, {delay, salt: saltOf(label)});
    await a.send(DEPLOYER, tl, op.scheduleCalldata);
    await expect(a.send(DEPLOYER, tl, op.executeCalldata), "not before the delay").rejects.toThrow();
    const end = (await drv.now()) + delay;
    for (let t = (await drv.now()) + 6n * 3600n; t < end; t += 6n * 3600n) await drv.freshRounds(t);
    await drv.freshRounds(end + 1n);
    expect(await a.client.readContract({address: tl, abi: timelockAbi, functionName: "isOperationReady", args: [op.id]})).toBe(true);
    await a.send(DEPLOYER, tl, op.executeCalldata);
    expect(await a.client.readContract({address: tl, abi: timelockAbi, functionName: "isOperationDone", args: [op.id]})).toBe(true);
    return op;
  }

  beforeAll(async () => {
    a = await startAnvil();
    drv = new ChainDriver(a, {log: () => {}});
    await drv.freshRounds(SEED_WED);
    await drv.lend("NVDA", lender, 500n * E18);
    await drv.allocate(["NVDA"]);
    await drv.borrow("NVDA", borrower, 10_000n * E6, 10n * E18);
  }, 300_000);
  afterAll(() => a?.stop());

  it("guard-tripped.md: manual trip → allocator pull empties free liquidity → borrow refused, repay works → clear", async () => {
    const nvda = a.d.stocks.NVDA;
    await drv.guardian("NVDA", "trip");
    expect((await reasons("NVDA")) & GUARD.MANUAL).toBe(GUARD.MANUAL);
    await drv.allocate(["NVDA"]);
    const m = await a.client.readContract({address: a.d.morpho, abi: morphoAbi, functionName: "market", args: [nvda.marketId]});
    expect(m.totalSupplyAssets - m.totalBorrowAssets <= 10n ** 15n + 10n ** 12n, "only seed/dust left").toBe(true);
    await expect(drv.borrow("NVDA", borrower, 1_000n * E6, E18)).rejects.toThrow(/GuardTripped/);
    await drv.repay("NVDA", borrower, E18);
    await drv.guardian("NVDA", "clear");
    expect(await reasons("NVDA")).toBe(0n);
    await drv.allocate(["NVDA"]);
  });

  it("multiplier-change.md: an unannounced multiplier change latches MULTIPLIER; the owner confirms through the timelock", async () => {
    await a.send(DEPLOYER, a.d.stocks.SPY.stockToken, call(mockStockTokenAbi, "setUIMultiplier", [13n * 10n ** 17n])); // +30%, no pause window
    await drv.poke(["SPY"]);
    expect((await reasons("SPY")) & 512n).toBe(512n); // MULTIPLIER
    await governed({kind: "oracle.clearMultiplierGuard", ticker: "SPY"}, "rehearsal SPY multiplier confirm");
    await drv.poke(["SPY"]);
    expect((await reasons("SPY")) & 512n).toBe(0n);
  }, 120_000);

  it("oracle-stale-or-rejected.md (A13): a genuine > 2x move is rejected until the owner re-anchors", async () => {
    await drv.poke(["AAPL"]);
    await drv.rounds({AAPL: drv.prices.AAPL * 21n / 10n});
    await drv.poke(["AAPL"]);
    expect((await reasons("AAPL")) & 16n).toBe(16n); // SANITY: the last good answer is kept
    await governed({kind: "oracle.resetReferences", ticker: "AAPL"}, "rehearsal AAPL re-anchor");
    await drv.poke(["AAPL"]);
    expect((await reasons("AAPL")) & 16n).toBe(0n);
    const [answer] = await a.client.readContract({address: a.d.stocks.AAPL.oracle, abi: stocklineOracleAbi, functionName: "stockAnswer"});
    expect(answer).toBe(drv.prices.AAPL);
  }, 120_000);

  it("calendar-push.md: push an earnings window through the timelock; it is onchain afterwards", async () => {
    const aapl = a.d.stocks.AAPL.stockToken;
    const n = await a.client.readContract({address: a.d.marketHours, abi: marketHoursAbi, functionName: "eventCount", args: [aapl]});
    const last = n > 0n ? await a.client.readContract({address: a.d.marketHours, abi: marketHoursAbi, functionName: "eventAt", args: [aapl, n - 1n]}) : undefined;
    const start = (last ? BigInt(last.startTs) : await drv.now()) + 90n * 86_400n;
    await governed({kind: "marketHours.replaceEventsFrom", ticker: "AAPL", fromIndex: n, events: [{startTs: start, endTs: start + 3600n, bufferWad: 8n * 10n ** 16n}]}, "rehearsal AAPL earnings push");
    expect(await a.client.readContract({address: a.d.marketHours, abi: marketHoursAbi, functionName: "eventCount", args: [aapl]})).toBe(n + 1n);
  }, 120_000);

  it("issuer-pause-or-blocklist.md (A25): token pause trips the guard; USDG-side exits still work", async () => {
    await drv.issuerPause("NVDA", true);
    expect((await reasons("NVDA")) & GUARD.TOKEN_PAUSED).toBe(GUARD.TOKEN_PAUSED);
    await a.send(borrower, a.d.router!, call(stocklineRouterAbi, "withdrawCollateral", [a.d.stocks.NVDA.stockToken, 500n * E6, borrower, (await drv.now()) + 600n]));
    await drv.issuerPause("NVDA", false);
    await drv.poke(["NVDA"]);
    expect((await reasons("NVDA")) & GUARD.TOKEN_PAUSED).toBe(0n);
  });

  it("list-stock.md fees (FE-R1): recipient switch through the vault's own timelock, then accrue → distribute", async () => {
    const nvda = a.d.stocks.NVDA;
    const splitter = a.d.feeSplitter!;
    const read = (functionName: string, args: readonly unknown[] = []) => a.client.readContract({address: nvda.vault, abi: vaultV2FullAbi, functionName, args} as never) as Promise<unknown>;
    expect(await read("performanceFeeRecipient")).toBe(splitter);
    // Testnet shape: a vault whose recipient is a placeholder. Move it away, then turn fees on with the SDK calldata.
    const placeholder = getAddress("0x00000000000000000000000000000000000fee00");
    async function throughVaultTimelock(recipient: `0x${string}`) {
      const op = vaultCuratorOperation(a.d, {kind: "vault.setPerformanceFeeRecipient", ticker: "NVDA", recipient});
      await a.send(a.d.roles.curator, nvda.vault, op.submitCalldata);
      await expect(a.send(DEPLOYER, nvda.vault, op.data), "not before the vault timelock").rejects.toThrow();
      const wait = (await read("executableAt", [op.data])) as bigint;
      for (let t = (await drv.now()) + 6n * 3600n; t < wait; t += 6n * 3600n) await drv.freshRounds(t);
      await drv.freshRounds(wait + 1n);
      await a.send(DEPLOYER, nvda.vault, op.data); // anyone executes
      return op;
    }
    // A sentinel (guardian) veto clears a pending change.
    const veto = vaultCuratorOperation(a.d, {kind: "vault.setPerformanceFeeRecipient", ticker: "NVDA", recipient: placeholder});
    await a.send(a.d.roles.curator, nvda.vault, veto.submitCalldata);
    await a.send(a.d.roles.guardian, nvda.vault, veto.revokeCalldata);
    expect(await read("executableAt", [veto.data])).toBe(0n);

    await throughVaultTimelock(placeholder);
    expect(await read("performanceFeeRecipient")).toBe(placeholder);
    await throughVaultTimelock(splitter);
    expect(await read("performanceFeeRecipient")).toBe(splitter);

    // Interest keeps accruing on the open borrow; fee shares reach the splitter; anyone distributes.
    await drv.freshRounds((await drv.now()) + 7n * 86_400n);
    await a.send(DEPLOYER, nvda.vault, call(vaultV2FullAbi, "accrueInterest"));
    const bal = (who: `0x${string}`) => a.client.readContract({address: nvda.vault, abi: erc20Abi, functionName: "balanceOf", args: [who]});
    const held = await bal(splitter);
    expect(held > 0n, "fee shares minted to the splitter").toBe(true);
    const [t0, b0] = [await bal(a.d.roles.treasury!), await bal(a.d.roles.backstopReserve!)];
    await a.send(lender, splitter, call(feeSplitterAbi, "distribute", [nvda.vault]));
    const [t1, b1] = [await bal(a.d.roles.treasury!), await bal(a.d.roles.backstopReserve!)];
    expect(t1 - t0 + (b1 - b0)).toBe(held);
    expect(await bal(splitter)).toBe(0n);
  }, 180_000);

  it("wrapper-backing-shortfall.md / usdg-freeze.md kill plan: delist through the timelock; entries stop, exits keep working", async () => {
    await governed({kind: "router.delistMarket", ticker: "NVDA"}, "rehearsal NVDA delist");
    await expect(drv.borrow("NVDA", borrower, 1_000n * E6, E18)).rejects.toThrow(/NotListed/);
    await drv.repay("NVDA", borrower);
    await a.send(borrower, a.d.router!, call(stocklineRouterAbi, "withdrawCollateral", [a.d.stocks.NVDA.stockToken, 2n ** 256n - 1n, borrower, (await drv.now()) + 600n]));
    const pos = await a.client.readContract({address: a.d.morpho, abi: morphoAbi, functionName: "position", args: [a.d.stocks.NVDA.marketId, borrower]});
    expect(pos.borrowShares).toBe(0n);
    expect(pos.collateral).toBe(0n);
  }, 120_000);

  it("direct-borrow.md: lower the global clUSDG cap through the timelock (new router entries stop at the cap)", async () => {
    await drv.lend("AAPL", lender, 50n * E18);
    await drv.allocate(["AAPL"]);
    await governed({kind: "router.setGlobalCap", cap: 1n}, "rehearsal global cap freeze");
    expect(await a.client.readContract({address: a.d.router!, abi: stocklineRouterAbi, functionName: "globalCap"})).toBe(1n);
    await expect(drv.borrow("AAPL", borrower, 5_000n * E6, E18)).rejects.toThrow(/GlobalCapExceeded/);
  }, 120_000);
});
