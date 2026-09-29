import {expect, test, type Page} from "@playwright/test";
import {createPublicClient, http, type PublicClient} from "viem";
import {deltaNeutralVaultAbi, erc20Abi, getDeployment, marketHoursAbi} from "@stockline/sdk";
import {ChainDriver, connectAnvil, DnDriver} from "@stockline/devnet";
import {E2E_ACCOUNT} from "./stack";

/**
 * USDG Earn (08). First on the fixture source (pinned per tab with `sessionStorage["vault-source"] = "fixture"`), with
 * the e2e wallet (anvil account #7, mock connector) signing the terms. Covers the entry (deposit through the review),
 * instant and queued exits, the claim after the queue settles (fixture clock), and APP-R2 for the vault: a
 * restricted visitor can claim from the portfolio but can't reach the deposit.
 */
type Fixture = {advance(s: number): void; reset(): void};
let page: Page;

async function stepsDone(p: Page) {
  const steps = p.getByTestId("steps").first();
  await expect(steps).toBeVisible();
  await expect(steps.locator('li[data-status="active"], li[data-status="pending"]')).toHaveCount(0, {timeout: 30_000});
  await expect(steps.locator('li[data-status="failed"]'), await steps.innerText()).toHaveCount(0);
}
async function confirmReview(p: Page) {
  await p.getByTestId("confirm").click();
  await stepsDone(p);
  await p.getByRole("button", {name: "Done"}).click();
}
/** Shrinks the fixture's cash buffer so the next withdrawal is (partly) queued, then reloads. */
async function setBuffer(p: Page, usdg: number) {
  await p.evaluate((v) => {
    const k = "vault-fixture:open";
    const L = JSON.parse(sessionStorage.getItem(k) ?? "{}");
    sessionStorage.setItem(k, JSON.stringify({...L, instant: v}));
  }, usdg);
  await p.reload();
}
const advance = (p: Page, s: number) => p.evaluate((sec) => (window as unknown as {__vaultFixture: Fixture}).__vaultFixture.advance(sec), s);

test.describe.serial("USDG Earn on fixtures", () => {
  test.beforeAll(async ({browser}) => {
    page = await browser.newPage();
    await page.addInitScript(() => sessionStorage.setItem("vault-source", "fixture"));
    await page.goto("/vault");
    await expect(page.getByTestId("account")).toBeVisible();
    await page.evaluate(() => {
      sessionStorage.clear();
      sessionStorage.setItem("vault-source", "fixture");
      (window as unknown as {__vaultFixture: Fixture}).__vaultFixture.reset();
    });
    await page.reload();
  });

  test("entry: deposit 5,000 USDG through the review (approve → terms signature → compliance check → deposit)", async () => {
    await expect(page.getByTestId("preview-badge")).toBeVisible();
    await expect(page.getByTestId("apy-label")).toHaveText("Net APY (30d, variable)");
    const before = await page.getByTestId("position-value").innerText();
    await page.getByTestId("deposit-amount").fill("5000");
    await expect(page.getByTestId("earn-estimate")).toContainText("(variable, not a forecast)");
    await page.getByTestId("deposit-submit").click();
    await expect(page.getByTestId("review-risks")).toBeVisible();
    await expect(page.getByTestId("steps").locator("li")).toHaveText([/Approve USDG/, /Accept the terms/, /Compliance check/, /Deposit 5,000 USDG/]);
    await confirmReview(page);
    await expect(page.getByTestId("toast").filter({hasText: "Deposited 5,000 USDG"})).toBeVisible();
    await expect(page.getByTestId("position-value")).not.toHaveText(before);
  });

  test("exit: instant withdrawal inside the cash buffer", async () => {
    await page.getByTestId("mode-withdraw").click();
    await page.getByTestId("withdraw-amount").fill("1000");
    await expect(page.getByTestId("withdraw-split")).toHaveText("1,000 USDG now");
    await page.getByTestId("withdraw-submit").click();
    await expect(page.getByTestId("steps").locator("li")).toHaveText([/Withdraw 1,000 USDG now/]);
    await confirmReview(page);
    await expect(page.getByTestId("toast").filter({hasText: "Withdrew 1,000 USDG"})).toBeVisible();
  });

  test("exit: queued withdrawal → the queue settles (fixture clock) → claim", async () => {
    await setBuffer(page, 1_000);
    await page.getByTestId("mode-withdraw").click();
    await page.getByTestId("withdraw-amount").fill("3000");
    await expect(page.getByTestId("withdraw-split")).toContainText("1,000 USDG now · 2,000 USDG queued, paid by");
    await page.getByTestId("withdraw-submit").click();
    await expect(page.getByTestId("rv-queue-note")).toContainText("72 hours or the next US market open");
    await expect(page.getByTestId("steps").locator("li")).toHaveText([/Withdraw 1,000 USDG now/, /Request 2,000 USDG/]);
    await confirmReview(page);
    const card = page.getByTestId("position-strip").locator('[data-status="queued"]');
    await expect(card).toContainText("2,000 USDG");
    await expect(card).toContainText("in the queue");

    await advance(page, 5 * 86_400);
    const ready = page.getByTestId("position-strip").locator('[data-status="ready"]');
    await expect(ready).toBeVisible({timeout: 15_000}); // the 5 s refetch picks it up
    await expect(page.getByTestId("toast").filter({hasText: "2,000 USDG is ready to claim"})).toBeVisible();
    await ready.getByRole("button", {name: "Claim 2,000 USDG"}).click();
    await page.getByTestId("confirm").click();
    await stepsDone(page);
    await expect(page.getByRole("dialog")).toContainText("Claimed 2,000 USDG"); // the success view outlives the card
    await page.getByRole("button", {name: "Done"}).click();
    await expect(page.getByTestId("position-strip").locator("[data-status]")).toHaveCount(0);
  });

  test("APP-R2: a restricted visitor claims from the portfolio but can't reach the deposit", async () => {
    // A queued request made before the visitor's region is known…
    await page.getByTestId("mode-withdraw").click();
    await page.getByTestId("withdraw-amount").fill("500");
    await expect(page.getByTestId("withdraw-split")).toContainText("500 USDG queued");
    await page.getByTestId("withdraw-submit").click();
    await confirmReview(page);
    await advance(page, 5 * 86_400);
    // …then from a restricted country.
    await page.setExtraHTTPHeaders({"x-vercel-ip-country": "US"});
    try {
      await page.goto("/vault");
      await expect(page.getByTestId("restricted")).toBeVisible();
      await expect(page.getByTestId("deposit-submit")).toHaveCount(0);

      await page.goto("/portfolio");
      const section = page.getByTestId("vault-position");
      await expect(section).toContainText("Deposits aren't available in your region. Withdrawals and claims are.");
      await section.getByRole("button", {name: "Claim 500 USDG"}).click();
      await page.getByTestId("confirm").click();
      await stepsDone(page);
      await expect(page.getByRole("dialog")).toContainText("Claimed 500 USDG");
      await page.getByRole("button", {name: "Done"}).click();
      await expect(section.getByRole("button", {name: "Withdraw"})).toBeEnabled();
    } finally {
      await page.setExtraHTTPHeaders({});
    }
  });

  test("390px: no horizontal overflow; the bottom bar opens the panel as a sheet", async () => {
    await page.setViewportSize({width: 390, height: 844});
    for (const path of ["/vault", "/portfolio", "/markets"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), path).toBeLessThanOrEqual(0);
    }
    await page.goto("/vault");
    await page.getByTestId("open-withdraw").click();
    await expect(page.getByTestId("vault-panel")).toHaveAttribute("role", "dialog");
    await expect(page.getByTestId("withdraw-form")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("vault-panel")).not.toHaveAttribute("role", "dialog");
    await page.setViewportSize({width: 1280, height: 900});
  });
});

/**
 * The same flows on the real contracts (Phase 4 task 16): the default source on anvil (`apiSource`: `/v1/vault/*`, the
 * chain and the wallet), the DeltaNeutralVault with the mock venue and dev caps, NAV reports by the dev signers.
 */
test.describe.serial("USDG Earn on chain", () => {
  const d = getDeployment(31337)!;
  const vault = d.dnVault!.vault;
  let client: PublicClient;
  let drv: ChainDriver;
  let dn: DnDriver;
  let p: Page;
  const shares = () => client.readContract({address: vault, abi: erc20Abi, functionName: "balanceOf", args: [E2E_ACCOUNT]});
  const usdg = () => client.readContract({address: d.usdg, abi: erc20Abi, functionName: "balanceOf", args: [E2E_ACCOUNT]});

  /** An open feed session, fresh rounds and a fresh NAV report. */
  async function openAndReport() {
    const now = await drv.now();
    if (!(await client.readContract({address: d.marketHours, abi: marketHoursAbi, functionName: "isOpen", args: [now]}))) {
      const [, reopen] = await client.readContract({address: d.marketHours, abi: marketHoursAbi, functionName: "closureWindows", args: [now]});
      await drv.freshRounds(reopen + 14n * 3600n); // 10:00 ET
    } else await drv.rounds();
    await dn.report();
  }

  test.beforeAll(async ({browser}) => {
    client = createPublicClient({transport: http(process.env.E2E_RPC_URL!)}) as PublicClient;
    drv = new ChainDriver(await connectAnvil(process.env.E2E_RPC_URL!));
    dn = new DnDriver(drv);
    p = await browser.newPage();
    await openAndReport();
    await drv.mintUsdg(E2E_ACCOUNT, 20_000n * 10n ** 6n);
    p.on("pageerror", (e) => console.log(`[browser] ${e.message}`));
    await p.goto("/vault");
    await expect(p.getByTestId("account")).toBeVisible();
    await expect(p.getByTestId("preview-badge")).toHaveCount(0); // real data: no "Preview"
  });

  test("DN-R6 deposit mints shares on DeltaNeutralVault at the share price (entry: approve → terms → compliance → deposit)", async () => {
    await openAndReport();
    const s0 = await shares();
    const price = await client.readContract({address: vault, abi: deltaNeutralVaultAbi, functionName: "sharePrice"});
    await p.reload();
    await p.getByTestId("deposit-amount").fill("5000");
    await expect(p.getByTestId("deposit-shares")).toBeVisible();
    await p.getByTestId("deposit-submit").click();
    await confirmReview(p);
    await expect(p.getByTestId("toast").filter({hasText: "Deposited 5,000 USDG"})).toBeVisible();
    const minted = (await shares()) - s0;
    const expected = (5000n * 10n ** 6n * 10n ** 30n) / price;
    const diff = minted > expected ? minted - expected : expected - minted;
    expect(diff * 1000n <= expected, `${minted} vs ${expected}`).toBe(true); // within 0.1%
  });

  test("DN-R1 instant withdraw burns shares up to the cash buffer (exit)", async () => {
    await openAndReport();
    const u0 = await usdg();
    const s0 = await shares();
    await p.reload();
    await p.getByTestId("mode-withdraw").click();
    await p.getByTestId("withdraw-amount").fill("1000");
    await expect(p.getByTestId("withdraw-split")).toHaveText("1,000 USDG now");
    await p.getByTestId("withdraw-submit").click();
    await confirmReview(p);
    expect((await usdg()) - u0).toBe(1000n * 10n ** 6n);
    expect(await shares()).toBeLessThan(s0);
  });

  test("DN-R1 a withdrawal above the buffer: part now, part queued; settled after a report; claim pays USDG", async () => {
    await openAndReport();
    // The operator deploys most of the idle cash (the vault keeps its 5% buffer).
    const idle = await client.readContract({address: vault, abi: deltaNeutralVaultAbi, functionName: "idleAssets"});
    const nav = await client.readContract({address: vault, abi: deltaNeutralVaultAbi, functionName: "totalAssets"});
    await dn.build(1, idle - (nav * 6n) / 100n, 0n);
    await dn.report();
    await p.reload();
    await p.getByTestId("mode-withdraw").click();
    await p.getByTestId("withdraw-amount").fill("2000");
    await expect(p.getByTestId("withdraw-split")).toContainText("USDG queued, paid by");
    await p.getByTestId("withdraw-submit").click();
    await expect(p.getByTestId("rv-queue-note")).toContainText("72 hours or the next US market open");
    await confirmReview(p);
    const queued = p.getByTestId("position-strip").locator('[data-status="queued"]');
    await expect(queued).toBeVisible({timeout: 15_000});
    // Cash comes back to the vault (here: a USDG top-up standing in for the rebalancer's unwind), then settlement.
    await drv.mintUsdg(vault, 10_000n * 10n ** 6n); // a donation also lifts the queued shares' value: over-cover it
    await dn.report();
    await dn.settle();
    const ready = p.getByTestId("position-strip").locator('[data-status="ready"]');
    await expect(ready).toBeVisible({timeout: 20_000});
    const u0 = await usdg();
    await ready.getByRole("button", {name: /^Claim/}).click();
    await p.getByTestId("confirm").click();
    await stepsDone(p);
    await p.getByRole("button", {name: "Done"}).click();
    expect(await usdg()).toBeGreaterThan(u0);
  });

  test("DN-R5 deposits are refused on a stale NAV; claiming a settled request still works", async () => {
    await openAndReport();
    const id = await dn.requestRedeem(E2E_ACCOUNT, (await shares()) / 10n);
    await dn.report();
    await dn.settle();
    await drv.warp((await drv.now()) + 20n * 60n); // no report for 20 minutes
    await p.reload();
    await p.getByTestId("mode-deposit").click().catch(() => {});
    await p.getByTestId("deposit-amount").fill("100");
    await expect(p.getByTestId("deposit-form")).toContainText("price data");
    await expect(p.getByTestId("deposit-submit")).toBeDisabled();
    const u0 = await usdg();
    const ready = p.getByTestId("position-strip").locator('[data-status="ready"]');
    await expect(ready).toBeVisible({timeout: 20_000});
    await ready.getByRole("button", {name: /^Claim/}).click();
    await p.getByTestId("confirm").click();
    await stepsDone(p);
    expect(await usdg()).toBeGreaterThan(u0);
    const r = await client.readContract({address: vault, abi: deltaNeutralVaultAbi, functionName: "request", args: [id]});
    expect(r.status).toBe(3); // Claimed
  });
});
