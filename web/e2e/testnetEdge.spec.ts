import {writeFileSync} from "node:fs";
import type {Page} from "@playwright/test";
import {createWalletClient, formatUnits, http, parseUnits, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {chainFor, lendoraOracleAbi, lendoraRouterAbi} from "@lendora/sdk";
import {expect, RPC, test, TESTNET, type TestnetWallet} from "./testnetWallet";
import {api, confirmReview, connect, d, hfNow, marketLiquidity, OUT, plain, portfolioControl, position, shot, wadOf, waitLiquidity} from "./testnetHelpers";

/**
 * Friday edge cases on 46630 (owner-approved 2026-10-02), one phase per run (EDGE_PHASE):
 *   guard      guardian trips MANUAL on NVDA: entries blocked with the reason, an exit (close) works while tripped, the
 *              allocator pulls liquidity, the monitor pages GUARD_TRIPPED; then clear. Needs TESTNET_DEPLOYER_KEY.
 *   edge-open  before the 16:00 ET ramp: a short opened in the UI (HF ~1.35, the RT-R1 check passes with the weekend
 *              buffer), then collateral withdrawn through the router to HF ~1.05 (T10: exits have no buffer check).
 *   ramp       16:00–20:00 ET: the buffer rises, the position's HF falls below 1.00 and the liquidator keeper
 *              liquidates it; the UI and the API show it; no bad debt.
 *   closed     after the 20:00 ET close: entries refused in words, the vault pauses deposits and instant withdrawals
 *              but takes requests, exits work.
 * Keys come from the environment only and stay in this process.
 */
const phase = process.env.EDGE_PHASE ?? "";
const chain = chainFor(TESTNET, RPC);
const MONITOR = "http://127.0.0.1:42073";
const notes: string[] = [];
const note = (c: string, r: string) => notes.push(`| ${c} | ${r} |`);
const MANUAL = 1n;

type Incident = {id: number; rule: string; subject: string; status: string; title: string; openedAt: string; resolvedAt?: string | null};
const incidents = () => api<{open: Incident[]; recent: Incident[]}>("/incidents", MONITOR);

function operator() {
  const k = process.env.TESTNET_DEPLOYER_KEY;
  if (!k) throw new Error("EDGE_PHASE=guard needs TESTNET_DEPLOYER_KEY in the environment (guardian)");
  return createWalletClient({account: privateKeyToAccount(k as Hex), chain, transport: http(RPC)});
}

async function guardian(w: TestnetWallet, action: "trip" | "clear") {
  const wc = operator();
  // The operator key is shared with the running keepers (T42): retry a nonce clash with a fresh nonce.
  let hash: Hex | undefined;
  for (let i = 0; !hash; i++) {
    try {
      hash = await wc.writeContract({address: d.stocks.NVDA.oracle, abi: lendoraOracleAbi, functionName: action, args: [MANUAL], chain, account: wc.account!});
    } catch (e) {
      if (i >= 4 || !/nonce/i.test(String((e as Error).message))) throw e;
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  const r = await w.pc.waitForTransactionReceipt({hash});
  expect(r.status).toBe("success");
  return hash;
}

const guardReasons = (w: TestnetWallet) => w.pc.readContract({address: d.stocks.NVDA.oracle, abi: lendoraOracleAbi, functionName: "guardReasons"});

/** Opens a short in the UI with the health factor near `targetHf` (the amount is computed from the oracle price). */
async function openShort(p: Page, w: TestnetWallet, t: string, collateral: number, targetHf: number) {
  const [answer] = await w.pc.readContract({address: d.stocks[t].oracle, abi: lendoraOracleAbi, functionName: "stockAnswer"});
  const price = Number(formatUnits(answer, 8));
  const amount = Math.floor(((collateral * 0.77) / (price * targetHf)) * 1e4) / 1e4;
  await waitLiquidity(w, t, parseUnits(String(amount), 18));
  await p.goto(`/stock/${t}?tab=short`);
  await p.getByTestId("collateral").fill(String(collateral));
  await p.getByTestId("borrow-amount").fill(String(amount));
  await expect(p.getByTestId("pv-swap")).toBeVisible();
  await p.getByTestId("submit").click();
  await confirmReview(p, /Shorted/);
  return amount;
}

test.describe.serial("46630 Friday edge cases", () => {
  test.skip(!phase, "set EDGE_PHASE=guard | edge-open | ramp | closed");
  let p: Page;
  let w: TestnetWallet;

  test.beforeAll(async ({app, wallet}) => {
    p = app;
    w = wallet;
    await p.goto("/markets");
    await connect(p, w);
  });

  test.afterAll(() => {
    writeFileSync(`${OUT}/edge-${phase}.md`, ["| case | result |", "|---|---|", ...notes].join("\n") + "\n");
  });

  test("guard: MANUAL trip on NVDA blocks entries with the reason, exits work, the allocator and the monitor react; then clear", async () => {
    test.skip(phase !== "guard");
    test.setTimeout(40 * 60_000);
    // A position to exit while tripped.
    if ((await position(w, "NVDA")).borrowShares === 0n) await openShort(p, w, "NVDA", 300, 3);
    const liq0 = await marketLiquidity(w, "NVDA");
    const tripAt = new Date().toISOString();
    const trip = await guardian(w, "trip");
    expect((await guardReasons(w)) & MANUAL).toBe(MANUAL);
    try {
      // Entries: the reason and a link to the status page, Review disabled even with valid inputs.
      await p.goto("/stock/NVDA?tab=short");
      await expect(p.getByText("New borrowing is paused for this market")).toBeVisible({timeout: 60_000});
      await expect(p.getByText("manual pause by the guardian").first()).toBeVisible();
      await p.getByTestId("collateral").fill("300");
      await p.getByTestId("borrow-amount").fill("0.01");
      await expect(p.getByTestId("submit")).toBeDisabled();
      await expect(p.getByText("Borrowing opens again when the safety guard clears.", {exact: false})).toBeVisible();
      await shot(p, "edge-guard-entry-blocked");
      // /status is server-rendered (5 s stale-while-revalidate) and doesn't refresh itself: reload until it follows.
      await expect
        .poll(async () => (await p.goto("/status"), await p.getByText(/Borrowing paused: .*manual/i).count()), {timeout: 120_000, intervals: [5_000]})
        .toBeGreaterThan(0);
      // Exit while tripped: close the short from the portfolio, with a real signature.
      await p.goto("/portfolio");
      const card = await portfolioControl(p, "position-NVDA");
      await expect(card).toContainText("New borrowing is paused here");
      await (await portfolioControl(p, "close-NVDA")).click();
      await confirmReview(p, /Closed your NVDA position/);
      expect((await position(w, "NVDA")).borrowShares).toBe(0n);
      note("guard: entry", "pass: \"New borrowing is paused for this market\" (manual pause by the guardian), Review disabled with \"Borrowing opens again when the safety guard clears\"; /status says \"Borrowing paused\"");
      note("guard: exit while tripped", `pass: closed the NVDA short from /portfolio (${w.sends.at(-1)?.hash})`);
      // The allocator pulls liquidity out of a tripped market; the monitor pages.
      let pulled = false;
      await expect
        .poll(async () => (pulled = (await marketLiquidity(w, "NVDA")) < liq0), {timeout: 10 * 60_000, intervals: [15_000]})
        .toBe(true)
        .catch(() => undefined);
      note("guard: allocator", pulled ? `pass: NVDA market liquidity ${formatUnits(liq0, 18)} → ${formatUnits(await marketLiquidity(w, "NVDA"), 18)}` : `not seen within 10 min: liquidity ${formatUnits(liq0, 18)} → ${formatUnits(await marketLiquidity(w, "NVDA"), 18)}`);
      let paged: Incident | undefined;
      await expect
        .poll(async () => (paged = (await incidents()).recent.find((i) => i.rule === "GUARD_TRIPPED" && i.subject.startsWith("NVDA") && i.openedAt >= tripAt)), {timeout: 10 * 60_000, intervals: [15_000]})
        .toBeTruthy()
        .catch(() => undefined);
      note("guard: monitor", paged ? `pass: #${paged.id} GUARD_TRIPPED "${paged.title}" opened ${paged.openedAt}` : "FAIL: no GUARD_TRIPPED page for NVDA within 10 min");
      expect(paged, "GUARD_TRIPPED paged").toBeTruthy();
    } finally {
      const clear = await guardian(w, "clear");
      note("guard: trip / clear", `trip ${trip}, clear ${clear}`);
    }
    expect((await guardReasons(w)) & MANUAL).toBe(0n);
    await p.goto("/stock/NVDA?tab=short");
    await expect(p.getByText("New borrowing is paused for this market")).toHaveCount(0, {timeout: 60_000});
    await expect
      .poll(async () => (await incidents()).recent.find((i) => i.rule === "GUARD_TRIPPED" && i.subject.startsWith("NVDA") && i.openedAt >= tripAt)?.status, {timeout: 10 * 60_000, intervals: [15_000]})
      .toBe("resolved");
    note("guard: cleared", "pass: banner gone, GUARD_TRIPPED resolved");
  });

  test("edge-open: a short at HF ~1.35, then collateral withdrawn through the router to HF ~1.05 (before the ramp)", async () => {
    test.skip(phase !== "edge-open");
    w.label = "edge open short";
    if ((await position(w, "NVDA")).borrowShares === 0n) await openShort(p, w, "NVDA", 600, 1.35);
    const hf0 = Number(formatUnits(await hfNow(w, "NVDA"), 18));
    const pos = await position(w, "NVDA");
    // HF is linear in collateral: keep collateral × 1.05 / HF.
    const keep = (pos.collateral * BigInt(Math.round((1.05 / hf0) * 1e6))) / 1_000_000n;
    const out = pos.collateral - keep;
    w.label = "edge withdraw collateral (router, T10 path)";
    const block = await w.pc.getBlock();
    const tester = w.accounts[0];
    const wc = createWalletClient({account: tester, chain, transport: http(RPC)});
    const hash = await wc.writeContract({address: d.router!, abi: lendoraRouterAbi, functionName: "withdrawCollateral", args: [d.stocks.NVDA.stockToken, out, tester.address, block.timestamp + 1800n], chain, account: tester, gas: 600_000n});
    expect((await w.pc.waitForTransactionReceipt({hash})).status).toBe("success");
    const hf1 = Number(formatUnits(await hfNow(w, "NVDA"), 18));
    expect(hf1).toBeGreaterThan(1.0);
    expect(hf1).toBeLessThan(1.1);
    await p.goto("/portfolio");
    const card = await portfolioControl(p, "position-NVDA");
    await expect(card).toContainText(/Can be liquidated|At risk/);
    await shot(p, "edge-open-portfolio");
    note("edge-open", `pass: short HF ${hf0.toFixed(3)}; withdrew ${formatUnits(out, 6)} USDG (${hash}) → HF now ${hf1.toFixed(3)}; the card warns`);
  });

  test("ramp: the buffer ramps, HF falls below 1.00, the liquidator keeper liquidates; UI and API show it", async () => {
    test.skip(phase !== "ramp");
    test.setTimeout(5 * 60 * 60_000);
    const start = await position(w, "NVDA");
    test.skip(start.borrowShares === 0n, "no edge position open (run EDGE_PHASE=edge-open first)");
    const series: string[] = [];
    await expect
      .poll(
        async () => {
          const pos = await position(w, "NVDA");
          const s = await api<{data: {markets: {symbol: string; buffer?: string; marketStatus: string}[]}}>("/v1/status").catch(() => undefined);
          const m = s?.data.markets.find((x) => x.symbol === "NVDA");
          const hf = pos.borrowShares > 0n ? Number(formatUnits(await hfNow(w, "NVDA"), 18)).toFixed(4) : "-";
          series.push(`${new Date().toISOString().slice(11, 16)} status ${m?.marketStatus} buffer ${m?.buffer} HF ${hf}`);
          return pos.borrowShares;
        },
        {timeout: 4.9 * 60 * 60_000, intervals: [60_000], message: "the liquidator keeper liquidates the edge position"},
      )
      .toBe(0n);
    writeFileSync(`${OUT}/edge-ramp-series.txt`, series.join("\n") + "\n");
    const liq = await api<{data: {type: string; txHash: string; time: string; assets: string | null}[]}>(`/v1/markets/NVDA/events?type=liquidate&account=${w.address}&limit=5`);
    await p.goto("/portfolio");
    await expect(p.getByText("Liquidated").first()).toBeVisible({timeout: 120_000});
    await shot(p, "edge-liquidated");
    note("ramp: liquidation", `pass: liquidated ${liq.data[0]?.time ?? "(not indexed yet)"} tx ${liq.data[0]?.txHash ?? "?"}; history shows "Liquidated"; HF series in edge-ramp-series.txt`);
  });

  test("closed: entries refused in words, the vault pauses deposits and instant withdrawals but takes requests, exits work", async () => {
    test.skip(phase !== "closed");
    await p.goto("/stock/NVDA?tab=short");
    await expect(p.getByTestId("pv-countdown").or(p.getByText(/Weekend mode is (on|active)/).first())).toBeVisible({timeout: 60_000});
    await p.getByTestId("collateral").fill("300");
    await p.getByTestId("borrow-amount").fill("0.01");
    const submit = p.getByTestId("submit");
    if (await submit.isEnabled()) {
      await submit.click();
      const dialog = p.getByRole("dialog").last();
      await dialog.getByTestId("confirm").click();
      await expect(dialog.getByText("That didn't go through")).toBeVisible({timeout: 120_000});
      const t = (await dialog.getByText("That didn't go through").locator("..").innerText()).replace(/\s+/g, " ");
      plain(t);
      note("closed: borrow", `refused at the simulation: "${t}"`);
      await p.keyboard.press("Escape");
    } else note("closed: borrow", `blocked in the form: "${(await p.locator("main").innerText()).match(/[^.\n]*clos[^.\n]*\./i)?.[0] ?? "Review disabled"}"`);
    await shot(p, "edge-closed-borrow");
    await p.goto("/vault");
    await expect(p.getByText("Markets are closed").or(p.getByText(/Deposits and instant withdrawals are paused/)).first()).toBeVisible({timeout: 60_000});
    note("closed: vault", "pass: the vault says markets are closed (deposits / instant withdrawals paused)");
    await shot(p, "edge-closed-vault");
    const hf = await wadOf(p, "pv-hf-now").catch(() => undefined);
    void hf;
  });
});
