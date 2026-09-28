import {expect, test, type Page} from "@playwright/test";

/**
 * USDG Earn (08) on the fixture source (NEXT_PUBLIC_FEATURE_VAULT=1; the contracts of task 14 don't exist yet), with
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
    await page.goto("/vault");
    await expect(page.getByTestId("account")).toBeVisible();
    await page.evaluate(() => {
      sessionStorage.clear();
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

test.describe("USDG Earn on chain", () => {
  test.fixme("needs task 14 contracts: deposit mints shares on DeltaNeutralVault at previewDeposit", async () => {});
  test.fixme("needs task 14 contracts: instant withdraw burns shares up to the cash buffer", async () => {});
  test.fixme("needs task 14 contracts: requestRedeem → settle after the next open → claim pays USDG", async () => {});
  test.fixme("needs task 14 contracts: deposits revert on a stale NAV; claims of settled requests don't", async () => {});
});
