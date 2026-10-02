import {mkdirSync} from "node:fs";
import type {Page} from "@playwright/test";
import {erc20Abi, formatUnits} from "viem";
import {getDeployment, morphoAbi, lendoraRouterAbi} from "@lendora/sdk";
import {expect, TESTNET, type TestnetWallet} from "./testnetWallet";

/** Shared by the 46630 browser specs (testnet.spec.ts, testnetEdge.spec.ts). */
export const d = getDeployment(TESTNET)!;
export const API = "http://127.0.0.1:42070";
export const COMPLIANCE = "http://127.0.0.1:42071";
export const OUT = "e2e/.results-testnet/rows";
mkdirSync(OUT, {recursive: true});

// ---- helpers ---------------------------------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON by default
export async function api<T = any>(path: string, base = API): Promise<T> {
  // The test and its browser share 127.0.0.1's free-tier quota (60/min): wait out a 429 instead of failing.
  for (let i = 0; ; i++) {
    const r = await fetch(base + path);
    if (r.status === 429 && i < 4) {
      const reset = Number(r.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      await new Promise((res) => setTimeout(res, Math.min(65_000, Math.max(2_000, reset - Date.now() + 500))));
      continue;
    }
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return (await r.json()) as T;
  }
}
export const shot = (p: Page, name: string) => p.screenshot({path: `${OUT}/${name}.png`, fullPage: true});

export async function connect(p: Page, w: TestnetWallet) {
  if (!p.url().startsWith("http")) await p.goto("/markets");
  await p.waitForLoadState("domcontentloaded");
  // wagmi reconnects a wallet that already trusts the site: give it a moment before offering Connect.
  if (await p.getByTestId("account").waitFor({timeout: 10_000}).then(() => true, () => false)) return;
  await p.getByTestId("connect").first().click();
  await p.getByRole("menuitem", {name: "Lendora Test Wallet"}).click();
  await expect(p.getByTestId("account")).toBeVisible();
  expect(w.isConnected).toBe(true);
}

/** The review sheet's steps all done, none failed (the failure text is the assertion message). */
export async function stepsDone(p: Page, timeout = 180_000) {
  const steps = p.getByRole("dialog").last().getByTestId("steps").first();
  await expect(steps).toBeVisible();
  // A run (or a retry) is over once Confirm no longer waits on the wallet.
  await expect(p.getByRole("dialog").last().getByRole("button", {name: "Confirm in your wallet…"})).toHaveCount(0, {timeout});
  await expect(steps.locator('li[data-status="active"], li[data-status="pending"]')).toHaveCount(0, {timeout});
  const failed = steps.locator('li[data-status="failed"]');
  if (await failed.count()) throw new Error(`step failed: ${await p.getByRole("dialog").last().innerText()}`);
}

/** Confirm in the open review sheet, wait for every step, check the success state, close it. */
export async function confirmReview(p: Page, success?: RegExp | string) {
  const dialog = p.getByRole("dialog").last();
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("confirm").click();
  await stepsDone(p);
  if (success) await expect(dialog.getByRole("heading").first()).toContainText(success);
  const open = await p.getByRole("dialog").count();
  await dialog.getByRole("button", {name: "Done"}).click();
  await expect(p.getByRole("dialog")).toHaveCount(open - 1); // the review closed (a sheet under it may stay)
}

export const bal = (token: `0x${string}`, who: `0x${string}`) => (w: TestnetWallet) => w.pc.readContract({address: token, abi: erc20Abi, functionName: "balanceOf", args: [who]});
export const position = (w: TestnetWallet, t: string, who = w.address) => w.pc.readContract({address: d.morpho, abi: morphoAbi, functionName: "position", args: [d.stocks[t].marketId, who]});
export async function marketLiquidity(w: TestnetWallet, t: string) {
  const m = await w.pc.readContract({address: d.morpho, abi: morphoAbi, functionName: "market", args: [d.stocks[t].marketId]});
  return m.totalSupplyAssets - m.totalBorrowAssets;
}
export async function hfNow(w: TestnetWallet, t: string) {
  const b = await w.pc.getBlock();
  return w.pc.readContract({address: d.router!, abi: lendoraRouterAbi, functionName: "healthFactorAt", args: [d.stocks[t].stockToken, w.address, b.timestamp]});
}
/** A `data-wad` value shown in a preview row. */
export async function wadOf(p: Page, testId: string) {
  const el = p.getByTestId(testId).locator("[data-wad]").first();
  await expect(el).toHaveAttribute("data-wad", /\d+/);
  return BigInt((await el.getAttribute("data-wad"))!);
}
/** Waits until the stock market row can lend this much (the allocator keeper supplies the vault's idle stock). */
export async function waitLiquidity(w: TestnetWallet, t: string, amount: bigint, timeout = 10 * 60_000) {
  await expect.poll(() => marketLiquidity(w, t), {timeout, intervals: [5_000], message: `${t} market liquidity ≥ ${formatUnits(amount, 18)} (allocator keeper)`}).toBeGreaterThanOrEqual(amount);
}

/** A /portfolio control: the page reads every market from the chain; if a read hangs (public RPC bursts), read again. */
export async function portfolioControl(p: Page, testId: string) {
  const b = p.getByTestId(testId);
  if (!(await b.waitFor({timeout: 45_000}).then(() => true, () => false))) {
    await p.reload();
    await b.waitFor({timeout: 60_000});
  }
  return b;
}

/** Plain words, never a raw revert (APP-R3). */
export function plain(text: string) {
  expect(text).not.toMatch(/unknown reason|0x[0-9a-f]{8,}|execution reverted|revert(ed)? with|ContractFunctionExecutionError|undefined|\[object/i);
}

