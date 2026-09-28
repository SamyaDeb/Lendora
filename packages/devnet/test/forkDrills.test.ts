import {spawnSync} from "node:child_process";
import {readFileSync, writeFileSync} from "node:fs";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {encodeFunctionData, getAddress, type Hex, type TransactionReceipt} from "viem";
import {
  decodeStocklineCall,
  erc20Abi,
  feeConverterAbi,
  feeSplitterAbi,
  marketHoursAbi,
  mockStockTokenAbi,
  mockSwapAggregatorAbi,
  morphoAbi,
  saltOf,
  stocklineOracleAbi,
  stocklineRouterAbi,
  stockWrapperAbi,
  timelockAbi,
  timelockOperation,
  vaultCuratorOperation,
  vaultV2FullAbi,
  type TimelockAction,
} from "@stockline/sdk";
import {CONTRACTS_DIR, startAnvil, type Anvil} from "../src/anvil.js";
import {ChainDriver, GUARD} from "../src/driver.js";

/**
 * Phase 3 task 11 without "go testnet": the testnet fee turn-on and every runbook drill, rehearsed on an **anvil fork of
 * 46630** (the real testnet deployment and its 24h timelock; nothing is sent to the testnet). The testnet deployer holds
 * every testnet role (A27) and operates the gated mocks, so it is impersonated here as it would sign there.
 *
 * Opt-in (needs the public testnet RPC): `FORK_DRILLS_46630=1 pnpm --filter @stockline/devnet exec vitest run
 * test/forkDrills.test.ts` (`TESTNET_RPC_URL` overrides the RPC). With `FORK_DRILLS_REPORT=1` it writes
 * docs/runbooks/fork-drills-46630.md.
 */
const RUN = process.env.FORK_DRILLS_46630 === "1";
const RPC = process.env.TESTNET_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com";
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const H = 3600n;
const call = (abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => (encodeFunctionData as (p: unknown) => Hex)({abi, functionName, args});

interface Step {
  drill: string;
  runbook: string;
  result: string;
  txs: string[];
  at: bigint;
}

describe.skipIf(!RUN)("runbook drills and fee turn-on on an anvil fork of 46630 (task 11)", () => {
  let a: Anvil;
  let drv: ChainDriver;
  let op: `0x${string}`;
  let forkBlock: bigint;
  const steps: Step[] = [];
  const t0 = Date.now();
  const borrower = "0x5700000000000000000000000000000000000c01" as const;
  const lender = "0x5700000000000000000000000000000000000c02" as const;
  const fees = {} as {feeSplitter: `0x${string}`; treasuryConverter: `0x${string}`; backstopConverter: `0x${string}`};
  const guardian = (t: string, fn: "trip" | "clear") => a.send(a.d.roles.guardian as `0x${string}`, a.d.stocks[t].oracle, call(stocklineOracleAbi, fn, [GUARD.MANUAL]));
  const reasons = (t: string) => a.client.readContract({address: a.d.stocks[t].oracle, abi: stocklineOracleAbi, functionName: "guardReasons"});
  const log = async (drill: string, runbook: string, result: string, rs: (TransactionReceipt | undefined)[]) =>
    steps.push({drill, runbook, result, txs: rs.filter((r): r is TransactionReceipt => !!r).map((r) => r.transactionHash), at: await drv.now()});

  /** Timelock: schedule (owner) → refused before the delay → wait the delay → execute, as the runbooks say. */
  async function governed(action: TimelockAction, label: string) {
    const tl = a.d.timelock;
    const delay = await a.client.readContract({address: tl, abi: timelockAbi, functionName: "getMinDelay"});
    const o = timelockOperation(a.d, action, {delay, salt: saltOf(`fork ${label}`)});
    const s = await a.send(op, tl, o.scheduleCalldata);
    await expect(a.send(op, tl, o.executeCalldata), "not before the delay").rejects.toThrow();
    const end = (await drv.now()) + delay;
    for (let t = (await drv.now()) + 6n * H; t < end; t += 6n * H) await drv.freshRounds(t);
    await drv.freshRounds(end + 1n);
    const e = await a.send(op, tl, o.executeCalldata);
    return {o, delay, rs: [s, e]};
  }

  beforeAll(async () => {
    a = await startAnvil({state: "empty", args: ["--fork-url", RPC]});
    expect(await a.client.getChainId()).toBe(46630);
    forkBlock = await a.client.getBlockNumber();
    op = a.d.roles.owner as `0x${string}`;
    drv = new ChainDriver(a, {operator: op, log: () => {}});
    // Start from a weekday session, a few hours after the fork's time.
    await drv.freshRounds((await drv.now()) + 60n);
    await drv.lend("NVDA", lender, 500n * E18);
    await drv.allocate(["NVDA"]);
    await drv.borrow("NVDA", borrower, 20_000n * E6, 20n * E18);
  }, 600_000);

  afterAll(() => {
    if (RUN && process.env.FORK_DRILLS_REPORT === "1" && steps.length) writeReport();
    a?.stop();
  });

  it("fees (FE-R1…R4): FeeSplitter + converters deployed, fee turned on through the 24h vault timelock, first distribution and conversion", async () => {
    // 1. DeployTestnetFees on the fork (TESTNET_GO=fork-dry-run), exactly as it would run after "go testnet".
    await a.test.impersonateAccount({address: op});
    await a.test.setBalance({address: op, value: 10n ** 20n});
    const r = spawnSync("forge", ["script", "script/DeployTestnetFees.s.sol", "--rpc-url", a.url, "--broadcast", "--unlocked", "--sender", op, "--slow"], {
      cwd: CONTRACTS_DIR,
      env: {...process.env, TESTNET_GO: "fork-dry-run"},
      encoding: "utf8",
    });
    expect(r.status, r.stderr?.slice(-2000)).toBe(0);
    Object.assign(fees, JSON.parse(readFileSync(`${CONTRACTS_DIR}/deployments/fork-46630-fees.json`, "utf8")));
    for (const k of ["feeSplitter", "treasuryConverter", "backstopConverter"] as const) fees[k] = getAddress(fees[k]);
    expect(await a.client.readContract({address: fees.feeSplitter, abi: feeSplitterAbi, functionName: "owner"})).toBe(getAddress(a.d.timelock));
    await log("Deploy FeeSplitter + 2 FeeConverters (`DeployTestnetFees.s.sol`, TESTNET_GO=fork-dry-run)", "list-stock.md (fees)", `splitter ${fees.feeSplitter}, converters ${fees.treasuryConverter} / ${fees.backstopConverter}, all owned by the timelock`, []);

    // 2. Fee recipient then 10% fee through each vault's curator timelock (24h on testnet).
    const rs: TransactionReceipt[] = [];
    for (const t of Object.keys(a.d.stocks)) {
      const v = a.d.stocks[t].vault;
      for (const action of [
        {kind: "vault.setPerformanceFeeRecipient" as const, ticker: t, recipient: fees.feeSplitter},
        {kind: "vault.setPerformanceFee" as const, ticker: t, feeWad: E18 / 10n},
      ]) {
        const o = vaultCuratorOperation(a.d, action);
        rs.push(await a.send(a.d.roles.curator as `0x${string}`, v, o.submitCalldata));
        await expect(a.send(op, v, o.data), "not before the vault timelock").rejects.toThrow();
        const wait = (await a.client.readContract({address: v, abi: vaultV2FullAbi, functionName: "executableAt", args: [o.data]})) as bigint;
        for (let x = (await drv.now()) + 6n * H; x < wait; x += 6n * H) await drv.freshRounds(x);
        await drv.freshRounds(wait + 1n);
        rs.push(await a.send(op, v, o.data));
      }
      expect(await a.client.readContract({address: v, abi: vaultV2FullAbi, functionName: "performanceFeeRecipient"})).toBe(fees.feeSplitter);
      expect(await a.client.readContract({address: v, abi: vaultV2FullAbi, functionName: "performanceFee"})).toBe(E18 / 10n);
    }
    await log("Turn the 10% performance fee on (recipient, then fee) in all 3 vaults through the 24h curator timelock", "list-stock.md (fees)", "refused before 24h, executed after; recipient = FeeSplitter, fee = 10%", rs);

    // 3. Interest accrues on the open borrow; anyone distributes; the fee keeper converts within 1% of the oracle.
    const nvda = a.d.stocks.NVDA;
    await drv.freshRounds((await drv.now()) + 2n * 86_400n);
    const acc = await a.send(lender, nvda.vault, call(vaultV2FullAbi, "accrueInterest"));
    const bal = (who: `0x${string}`, token: `0x${string}` = nvda.vault) => a.client.readContract({address: token, abi: erc20Abi, functionName: "balanceOf", args: [who]});
    const held = await bal(fees.feeSplitter);
    expect(held > 0n, "fee shares minted to the splitter").toBe(true);
    const dist = await a.send(lender, fees.feeSplitter, call(feeSplitterAbi, "distribute", [nvda.vault]));
    const [ts, bs] = [await bal(fees.treasuryConverter), await bal(fees.backstopConverter)];
    expect(ts + bs).toBe(held);
    await log("First distribution (NVDA, after 2 days of interest)", "keeper-down.md (MON-R20)", `${held} fee shares → ${ts} treasury / ${bs} backstop converter`, [acc, dist]);

    const stockIn = await a.client.readContract({address: nvda.vault, abi: vaultV2FullAbi, functionName: "previewRedeem", args: [ts]});
    const [value, floor] = await a.client.readContract({address: fees.treasuryConverter, abi: feeConverterAbi, functionName: "quote", args: [nvda.vault, stockIn]});
    const dex = a.d.mocks!.swapAggregator;
    const swap = {target: dex, data: call(mockSwapAggregatorAbi, "swap", [nvda.stockToken, a.d.usdg, stockIn, 0n, fees.treasuryConverter])};
    const treasury = getAddress(op); // testnet default treasury = deployer
    const before = await bal(treasury, a.d.usdg);
    await expect(a.send(lender, fees.treasuryConverter, call(feeConverterAbi, "convert", [nvda.vault, ts, floor, swap])), "keeper only").rejects.toThrow(/NotKeeper/);
    await expect(a.send(op, fees.treasuryConverter, call(feeConverterAbi, "convert", [nvda.vault, ts, floor - 1n, swap])), "1% floor").rejects.toThrow(/SlippageTooLoose/);
    const conv = await a.send(op, fees.treasuryConverter, call(feeConverterAbi, "convert", [nvda.vault, ts, floor, swap]));
    const got = (await bal(treasury, a.d.usdg)) - before;
    expect(got >= floor).toBe(true);
    await log("First conversion (treasury share, NVDA → USDG through the mock DEX)", "list-stock.md (fees), FE-R4", `oracle value ${value} USDG raw, floor ${floor}, received ${got}; non-keeper and below-floor calls refused`, [conv]);
  }, 900_000);

  it("guard-tripped.md: guardian trips MANUAL → allocator pull → borrow refused, repay works → clear", async () => {
    const t = await guardian("NVDA", "trip");
    expect((await reasons("NVDA")) & GUARD.MANUAL).toBe(GUARD.MANUAL);
    await drv.allocate(["NVDA"]);
    await expect(drv.borrow("NVDA", borrower, 1_000n * E6, E18)).rejects.toThrow(/GuardTripped/);
    await drv.repay("NVDA", borrower, E18);
    const c = await guardian("NVDA", "clear");
    expect(await reasons("NVDA")).toBe(0n);
    await drv.allocate(["NVDA"]);
    await log("Guard tripped (MANUAL) and cleared by the guardian", "guard-tripped.md", "pull emptied free liquidity; borrow refused (GuardTripped); repay worked; guard cleared", [t, c]);
  }, 300_000);

  it("keeper-down.md: allocator down during a guard trip → the guardian (sentinel) deallocates by hand", async () => {
    const nvda = a.d.stocks.NVDA;
    await drv.guardian("NVDA", "trip");
    const id = nvda.adapterMarketCapId as Hex;
    const allocated = await a.client.readContract({address: nvda.vault, abi: vaultV2FullAbi, functionName: "allocation", args: [id]});
    const m = await a.client.readContract({address: a.d.morpho, abi: morphoAbi, functionName: "market", args: [nvda.marketId]});
    const free = m.totalSupplyAssets - m.totalBorrowAssets;
    const amount = free < allocated ? free : allocated;
    const params = await a.client.readContract({address: a.d.router!, abi: stocklineRouterAbi, functionName: "market", args: [nvda.stockToken]});
    const dataArg = encodeFunctionData({abi: [{type: "function", name: "f", inputs: [{type: "tuple", components: [{name: "loanToken", type: "address"}, {name: "collateralToken", type: "address"}, {name: "oracle", type: "address"}, {name: "irm", type: "address"}, {name: "lltv", type: "uint256"}]}], outputs: [], stateMutability: "pure"}], functionName: "f", args: [params.params]}).slice(10);
    const r = await a.send(a.d.roles.guardian as `0x${string}`, nvda.vault, call(vaultV2FullAbi, "deallocate", [nvda.adapter, `0x${dataArg}`, amount]));
    const after = await a.client.readContract({address: nvda.vault, abi: vaultV2FullAbi, functionName: "allocation", args: [id]});
    // deallocate accrues interest first, so the allocation grows by a few wei of interest before the pull
    expect(after < allocated).toBe(true);
    expect(after - (allocated - amount) <= allocated / 1_000_000n).toBe(true);
    const c = await guardian("NVDA", "clear");
    await drv.allocate(["NVDA"]);
    await log("Allocator down during a trip: guardian deallocates by hand", "keeper-down.md, guard-tripped.md", `sentinel deallocated ${amount} (allocation ${allocated} → ${after}); detection of the down keeper is the monitor test (MON-R9)`, [r, c]);
  }, 300_000);

  it("multiplier-change.md: an unannounced multiplier change latches MULTIPLIER; the owner confirms through the 24h timelock", async () => {
    const m = await a.send(op, a.d.stocks.SPY.stockToken, call(mockStockTokenAbi, "setUIMultiplier", [13n * 10n ** 17n]));
    await drv.poke(["SPY"]);
    expect((await reasons("SPY")) & 512n).toBe(512n);
    const g = await governed({kind: "oracle.clearMultiplierGuard", ticker: "SPY"}, "SPY multiplier confirm");
    await drv.poke(["SPY"]);
    expect((await reasons("SPY")) & 512n).toBe(0n);
    await log("Multiplier change (SPY +30%, no pause window) → MULTIPLIER latched → owner confirms", "multiplier-change.md", `latched; cleared through the timelock after ${g.delay} s`, [m, ...g.rs]);
  }, 300_000);

  it("oracle-stale-or-rejected.md (A13): a > 2x move is rejected until the owner re-anchors (resetReferences)", async () => {
    await drv.poke(["AAPL"]);
    await drv.rounds({AAPL: (drv.prices.AAPL * 21n) / 10n});
    await drv.poke(["AAPL"]);
    expect((await reasons("AAPL")) & 16n).toBe(16n);
    const g = await governed({kind: "oracle.resetReferences", ticker: "AAPL"}, "AAPL re-anchor");
    await drv.poke(["AAPL"]);
    expect((await reasons("AAPL")) & 16n).toBe(0n);
    await log("Oracle re-anchor after a 2.1x move", "oracle-stale-or-rejected.md", `SANITY latched; resetReferences through the timelock (${g.delay} s); accepted afterwards`, g.rs);
  }, 300_000);

  it("calendar-push.md: push an earnings window through the 24h timelock", async () => {
    const aapl = a.d.stocks.AAPL.stockToken;
    const n = await a.client.readContract({address: a.d.marketHours, abi: marketHoursAbi, functionName: "eventCount", args: [aapl]});
    const last = n > 0n ? await a.client.readContract({address: a.d.marketHours, abi: marketHoursAbi, functionName: "eventAt", args: [aapl, n - 1n]}) : undefined;
    const start = (last ? BigInt(last.startTs) : await drv.now()) + 90n * 86_400n;
    const g = await governed({kind: "marketHours.replaceEventsFrom", ticker: "AAPL", fromIndex: n, events: [{startTs: start, endTs: start + H, bufferWad: 8n * 10n ** 16n}]}, "AAPL earnings push");
    expect(await a.client.readContract({address: a.d.marketHours, abi: marketHoursAbi, functionName: "eventCount", args: [aapl]})).toBe(n + 1n);
    await log("Calendar push (AAPL earnings window)", "calendar-push.md", `event ${n} onchain after the timelock`, g.rs);
  }, 300_000);

  it("governance-change.md: an unexpected schedule is decoded (what the monitor pages) and cancelled by the owner", async () => {
    const tl = a.d.timelock;
    const delay = await a.client.readContract({address: tl, abi: timelockAbi, functionName: "getMinDelay"});
    const attacker = "0x00000000000000000000000000000000000bad01" as const;
    const o = timelockOperation(a.d, {kind: "router.setAttestationSigner", signer: attacker} as TimelockAction, {delay, salt: saltOf("fork unexpected signer change")});
    const s = await a.send(op, tl, o.scheduleCalldata);
    const decoded = decodeStocklineCall(a.d, a.d.router!, o.data as Hex);
    expect(decoded.summary).toMatch(/setAttestationSigner/);
    const c = await a.send(op, tl, call(timelockAbi, "cancel", [o.id]));
    await drv.freshRounds((await drv.now()) + delay + 1n);
    expect(await a.client.readContract({address: tl, abi: timelockAbi, functionName: "isOperationReady", args: [o.id]})).toBe(false);
    await expect(a.send(op, tl, o.executeCalldata), "cancelled operations never execute").rejects.toThrow();
    await log("Unexpected schedule (attestation signer → attacker) decoded and cancelled", "governance-change.md", `page text: "${decoded.summary}"; cancelled; execute refused after the delay`, [s, c]);
  }, 300_000);

  it("P0 tabletop, wrapper-backing-shortfall.md: issuer adminBurn → shortfall → delist through the timelock; entries stop, exits work", async () => {
    const nvda = a.d.stocks.NVDA;
    const burn = await a.send(op, nvda.stockToken, call(mockStockTokenAbi, "adminBurn", [nvda.wrapper, E18]));
    const shortfall = await a.client.readContract({address: nvda.wrapper, abi: stockWrapperAbi, functionName: "backingShortfall"});
    expect(shortfall > 0n).toBe(true);
    const g = await governed({kind: "router.delistMarket", ticker: "NVDA"}, "NVDA delist");
    await expect(drv.borrow("NVDA", borrower, 1_000n * E6, E18)).rejects.toThrow(/NotListed/);
    await drv.repay("NVDA", borrower);
    const w = await a.send(borrower, a.d.router!, call(stocklineRouterAbi, "withdrawCollateral", [nvda.stockToken, 2n ** 256n - 1n, borrower, (await drv.now()) + 600n]));
    const pos = await a.client.readContract({address: a.d.morpho, abi: morphoAbi, functionName: "position", args: [nvda.marketId, borrower]});
    expect(pos.borrowShares).toBe(0n);
    expect(pos.collateral).toBe(0n);
    await log("P0 tabletop: wrapper backing shortfall (issuer adminBurn 1 NVDA)", "wrapper-backing-shortfall.md", `shortfall ${shortfall}; delisted through the timelock; borrow refused (NotListed); repay + withdraw all worked`, [burn, ...g.rs, w]);
  }, 300_000);

  function writeReport() {
    const date = new Date().toISOString();
    const lines = [
      "# Runbook drills on an anvil fork of 46630 (Phase 3 task 11)",
      "",
      `Run ${date} by \`packages/devnet/test/forkDrills.test.ts\` (${Math.round((Date.now() - t0) / 1000)} s). **Rehearsed on a fork, not on testnet**: no`,
      `"go testnet" was given, so every transaction below ran on a local anvil fork of 46630 at block ${forkBlock} (the real`,
      "testnet deployment and its 24h timelocks). The testnet deployer (holder of every testnet role, A27) was impersonated.",
      "Tx hashes are fork-local. Ran by: engineering (Claude Code session), owner review pending.",
      "",
      "| # | Drill | Runbook | Result | Chain time (UTC) | Fork txs |",
      "|---|---|---|---|---|---|",
      ...steps.map((s, i) => `| ${i + 1} | ${s.drill} | ${s.runbook} | ${s.result} | ${new Date(Number(s.at) * 1000).toISOString().slice(0, 16)} | ${s.txs.map((h) => `\`${h.slice(0, 10)}…\``).join(" ") || "–"} |`),
      "",
      "Re-run: `FORK_DRILLS_46630=1 FORK_DRILLS_REPORT=1 pnpm --filter @stockline/devnet exec vitest run test/forkDrills.test.ts`.",
      "",
    ];
    writeFileSync(new URL("../../../docs/runbooks/fork-drills-46630.md", import.meta.url), lines.join("\n"));
  }
});
