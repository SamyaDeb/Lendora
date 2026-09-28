import {expect, test, type Page} from "@playwright/test";
import {createPublicClient, http, type PublicClient} from "viem";
import {erc20Abi, getDeployment, morphoAbi, stocklineRouterAbi} from "@stockline/sdk";
import {ChainDriver, connectAnvil} from "@stockline/devnet";
import {E2E_ACCOUNT} from "./stack";

/**
 * 06 acceptance on anvil: every router flow of 05 §4 driven from the UI (lend, withdrawLend, openShort, borrow,
 * addCollateral, repay, withdrawCollateral, closeShort), the preview matching the onchain result within 0.1%, and the
 * APP-R2 / APP-R4 states.
 */
const d = getDeployment(31337)!;
const rpc = () => process.env.E2E_RPC_URL!;
let client: PublicClient;
let page: Page;

async function stepsDone(p: Page) {
  const steps = p.getByTestId("steps").first();
  await expect(steps).toBeVisible();
  await expect(steps.locator('li[data-status="active"], li[data-status="pending"]')).toHaveCount(0, {timeout: 60_000});
  await expect(steps.locator('li[data-status="failed"]'), await steps.innerText()).toHaveCount(0);
}

async function position(ticker: string) {
  return client.readContract({address: d.morpho, abi: morphoAbi, functionName: "position", args: [d.stocks[ticker].marketId, E2E_ACCOUNT]});
}

/** |a − b| / b ≤ 0.1% (06 acceptance). */
function within01pct(a: bigint, b: bigint) {
  const diff = a > b ? a - b : b - a;
  return diff * 1000n <= b;
}

test.describe.serial("Stockline app on anvil", () => {
  test.beforeAll(async ({browser}) => {
    client = createPublicClient({transport: http(rpc())}) as PublicClient;
    page = await browser.newPage();
    await page.goto("/");
    await expect(page.getByTestId("account")).toBeVisible(); // the e2e mock connector (anvil account #7) connects
  });

  test("APP-R5 markets: every stock with status, sortable by utilization", async () => {
    await page.goto("/");
    const rows = page.getByTestId("markets").locator("tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(page.getByTestId("markets")).toContainText("Open");
    const utils = await page.locator('[data-col="utilization"]').allInnerTexts();
    const nums = utils.map((u) => Number(u.replace("%", "")));
    expect([...nums].sort((a, b) => b - a)).toEqual(nums);
  });

  test("US-L1 lend NVDA through the router", async () => {
    await page.goto("/lend/NVDA");
    await page.getByTestId("amount").fill("25");
    await page.getByTestId("submit").click();
    await stepsDone(page);
    const shares = await client.readContract({address: d.stocks.NVDA.vault, abi: erc20Abi, functionName: "balanceOf", args: [E2E_ACCOUNT]});
    expect(shares).toBeGreaterThan(0n);
  });

  test("US-B2 open a short; 06 acceptance: preview HF and debt match the onchain result within 0.1%", async () => {
    await page.goto("/short/NVDA");
    await page.getByTestId("collateral").fill("20000");
    await page.getByTestId("borrow-amount").fill("10");
    const hf = page.getByTestId("pv-hf-now").locator("[data-wad]");
    await expect(hf).toHaveAttribute("data-wad", /\d+/);
    await expect(page.getByTestId("pv-countdown")).toBeVisible();
    await expect(page.getByTestId("pv-swap")).toBeVisible();
    await expect(page.getByTestId("preview")).toContainText("manufactured dividends");
    const previewHf = BigInt((await hf.getAttribute("data-wad"))!);
    const previewDebt = BigInt((await page.getByTestId("pv-borrowed").getAttribute("data-wad"))!);
    await page.getByTestId("submit").click();
    await stepsDone(page);
    const block = await client.getBlock();
    const onchainHf = await client.readContract({address: d.router!, abi: stocklineRouterAbi, functionName: "healthFactorAt", args: [d.stocks.NVDA.stockToken, E2E_ACCOUNT, block.timestamp]});
    const pos = await position("NVDA");
    const m = await client.readContract({address: d.morpho, abi: morphoAbi, functionName: "market", args: [d.stocks.NVDA.marketId]});
    const debt = (pos.borrowShares * (m.totalBorrowAssets + 1n) + m.totalBorrowShares + 10n ** 6n - 1n) / (m.totalBorrowShares + 10n ** 6n);
    console.log(`[06 acceptance] preview HF ${previewHf} vs onchain ${onchainHf}; debt ${previewDebt} vs ${debt}`);
    expect(within01pct(previewHf, onchainHf)).toBe(true);
    expect(within01pct(previewDebt, debt)).toBe(true);
  });

  test("US-B1 just borrow AAPL; preview matches onchain within 0.1%", async () => {
    await page.goto("/short/AAPL");
    await page.getByTestId("mode-borrow").check({force: true});
    await page.getByTestId("collateral").fill("5000");
    await page.getByTestId("borrow-amount").fill("3");
    const hf = page.getByTestId("pv-hf-now").locator("[data-wad]");
    await expect(hf).toHaveAttribute("data-wad", /\d+/);
    const previewHf = BigInt((await hf.getAttribute("data-wad"))!);
    await page.getByTestId("submit").click();
    await stepsDone(page);
    const block = await client.getBlock();
    const onchainHf = await client.readContract({address: d.router!, abi: stocklineRouterAbi, functionName: "healthFactorAt", args: [d.stocks.AAPL.stockToken, E2E_ACCOUNT, block.timestamp]});
    expect(within01pct(previewHf, onchainHf)).toBe(true);
  });

  test("US-B5 add collateral, repay, withdraw collateral from the portfolio", async () => {
    await page.goto("/portfolio");
    const nvda = page.getByTestId("position-NVDA");
    await expect(nvda).toContainText("Health factor now");
    const before = (await position("NVDA")).collateral;
    await page.getByTestId("add-amount-NVDA").fill("1000");
    await page.getByTestId("add-NVDA").click();
    await stepsDone(page);
    expect((await position("NVDA")).collateral).toBe(before + 1000n * 10n ** 6n);

    await page.getByTestId("repay-AAPL").click();
    await expect(page.getByTestId("position-AAPL").getByTestId("steps").locator('li[data-status="done"]').last()).toBeVisible({timeout: 60_000});
    await expect.poll(async () => (await position("AAPL")).borrowShares, {timeout: 30_000}).toBe(0n);
    // RT-R8: without debt, "Add collateral" is gone (rescue top-up only); withdrawing stays available.
    await expect(page.getByTestId("add-AAPL")).toHaveCount(0, {timeout: 30_000});
    await page.getByTestId("withdraw-collateral-AAPL").click();
    await expect.poll(async () => (await position("AAPL")).collateral, {timeout: 60_000}).toBe(0n);
  });

  test("APP-R4 a tripped guard disables borrowing with the reason; exits stay enabled", async () => {
    const drv = new ChainDriver(await connectAnvil(rpc()));
    await drv.guardian("NVDA", "trip");
    try {
      await page.goto("/short/NVDA");
      await expect(page.getByText("New borrowing is paused for this market")).toBeVisible();
      await expect(page.getByText("manual pause by the guardian")).toBeVisible();
      await page.getByTestId("collateral").fill("1000");
      await page.getByTestId("borrow-amount").fill("1");
      await expect(page.getByTestId("submit")).toBeDisabled();
      await page.goto("/portfolio");
      await expect(page.getByTestId("close-NVDA")).toBeEnabled();
    } finally {
      await drv.guardian("NVDA", "clear");
    }
  });

  test("US-B4 close the short (buy back with USDG) and US-L3 withdraw the lend", async () => {
    await page.goto("/portfolio");
    await page.getByTestId("close-NVDA").click();
    await expect.poll(async () => (await position("NVDA")).borrowShares, {timeout: 60_000}).toBe(0n);
    expect((await position("NVDA")).collateral).toBe(0n);
    await page.reload();
    await page.getByTestId("withdraw-lend-NVDA").click();
    await expect.poll(async () => client.readContract({address: d.stocks.NVDA.vault, abi: erc20Abi, functionName: "balanceOf", args: [E2E_ACCOUNT]}), {timeout: 60_000}).toBe(0n);
  });

  test("APP-R8 alert settings are saved with a signed message", async () => {
    await page.goto("/alerts");
    await page.getByLabel("Alert when health factor is below").fill("1.4");
    await page.getByLabel("Webhook URL (HTTPS)").fill("http://127.0.0.1:9/stockline");
    await page.getByRole("button", {name: "Save alert settings"}).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Alert when health factor is below")).toHaveValue("1.4");
  });

  test("07 dashboard: leaderboard, chart and weekend panel", async () => {
    await page.goto("/short-interest");
    await expect(page.getByTestId("leaderboard").locator("tbody tr")).toHaveCount(3);
    await expect(page.getByText("Weekend panel")).toBeVisible();
    await expect(page.getByText("Built on this data")).toBeVisible();
    // FE-R5: the seed week accrued fees; the panel shows them (historical, variable).
    await expect(page.getByTestId("revenue")).toContainText("Protocol revenue (historical");
    await expect(page.getByTestId("revenue-total")).toContainText("$");
  });
});

test.describe("APP-R2 restricted region", () => {
  test.use({extraHTTPHeaders: {"x-vercel-ip-country": "US"}});

  test("sees the block page on markets and borrow, but can reach the portfolio to exit", async ({page: p}) => {
    await p.goto("/");
    await expect(p.getByTestId("restricted")).toBeVisible();
    await p.goto("/short/NVDA");
    await expect(p.getByTestId("restricted")).toBeVisible();
    await p.goto("/portfolio");
    await expect(p.getByText("You can still repay, close and withdraw")).toBeVisible();
  });
});
