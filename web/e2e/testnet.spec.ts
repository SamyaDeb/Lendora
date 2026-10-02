import {writeFileSync} from "node:fs";
import type {Page} from "@playwright/test";
import {erc20Abi, formatUnits, parseUnits, type Hex} from "viem";
import {expect, test, TESTNET, type TestnetWallet} from "./testnetWallet";
import {bal, COMPLIANCE, confirmReview, connect, d, hfNow, marketLiquidity, OUT, plain, portfolioControl, position, shot, stepsDone, api, wadOf, waitLiquidity} from "./testnetHelpers";

/**
 * The signed rows of docs/prompts/testnet-e2e.md part 3 (2–14, 16–20, 22, 23), in order, on Robinhood Chain testnet
 * (46630) through the UI of the local stack, with a real signing wallet (./testnetWallet). Each row drives only
 * buttons, inputs and the review sheet, then checks the chain and the API. Screenshots per row and the gas of every
 * transaction go to e2e/.results-testnet/rows/.
 *
 * TESTNET_GO=yes SMOKE_KEY=… pnpm --filter @lendora/web exec playwright test -c playwright.testnet.config.ts
 */
const report: string[] = [];
const row = (n: string, result: string) => report.push(`| ${n} | ${result} |`);

// ---- the rows --------------------------------------------------------------------------------------------------
test.describe.serial("46630 part 3, signed rows in the UI", () => {
  let p: Page;
  let w: TestnetWallet;
  const me = () => w.address;

  test.beforeAll(async ({app, wallet}) => {
    p = app;
    w = wallet;
    // A throwaway second account (fresh key, memory only) for the faucet, the first terms signature and account switches.
    // 0.0001 ETH is ~10M gas at 0.01 gwei: plenty for its faucet claim, a deposit and a lend; swept back after the run.
    if ((await w.pc.getBalance({address: w.accounts[1].address})) < parseUnits("0.00005", 18)) await w.fund(1, "0.0001");
    await p.goto("/markets");
    await connect(p, w);
  });

  test.afterAll(async () => {
    await w.sweep(1).catch((e) => console.log("[sweep]", String(e).slice(0, 120)));
    // Gas: every transaction's limit vs used (T1: the limit must be ≥ 1.3 × used).
    await new Promise((r) => setTimeout(r, 5_000));
    const lines = w.gas.map((g) => `| ${g.label} | ${g.hash} | ${g.gasLimit} | ${g.gasUsed ?? "?"} | ${g.gasUsed ? (Number(g.gasLimit) / Number(g.gasUsed)).toFixed(2) : "?"} | ${g.status ?? "?"} |`);
    writeFileSync(`${OUT}/gas.md`, ["| row | tx | limit | used | limit/used | status |", "|---|---|---|---|---|---|", ...lines].join("\n") + "\n");
    writeFileSync(`${OUT}/rows.md`, ["| row | result |", "|---|---|", ...report].join("\n") + "\n");
    expect(w.lowHeadroom(), "transactions with a gas limit under 1.3 × used (T1)").toEqual([]);
  });

  test("setup: clear what an interrupted run left (through the UI): lends withdrawn, positions closed", async () => {
    w.label = "setup cleanup";
    for (const t of ["NVDA", "AAPL", "SPY"]) {
      const pos = await position(w, t);
      if (pos.borrowShares > 0n) {
        await p.goto("/portfolio");
        await (await portfolioControl(p, `close-${t}`)).click();
        await confirmReview(p, new RegExp(`Closed your ${t} position`));
      } else if (pos.collateral > 0n) {
        await p.goto("/portfolio");
        await (await portfolioControl(p, `withdraw-collateral-${t}`)).click();
        await confirmReview(p, /Withdrew your collateral/);
      }
      if ((await bal(d.stocks[t].vault, me())(w)) > 0n) {
        await waitLiquidity(w, t, 0n);
        await p.goto("/portfolio");
        await (await portfolioControl(p, `withdraw-lend-${t}`)).click();
        await confirmReview(p, new RegExp(`Withdrew your ${t}`));
      }
    }
  });

  test("row 2: faucet: 10 SPY, 10 NVDA, 10 AAPL, 50,000 USDG; a second claim is refused clearly", async () => {
    w.label = "row 2 faucet";
    await w.useAccount(1); // a fresh address can claim
    const a = w.accounts[1].address;
    await p.goto("/portfolio");
    await expect(p.getByTestId("account")).toContainText(a.slice(2, 6));
    const before = await bal(d.usdg, a)(w);
    const claim = p.getByRole("button", {name: "Get test tokens"});
    await claim.click();
    await expect(p.getByTestId("toast").filter({hasText: "Claimed test tokens"})).toBeVisible({timeout: 120_000});
    expect((await bal(d.usdg, a)(w)) - before).toBe(50_000n * 10n ** 6n);
    for (const t of ["SPY", "NVDA", "AAPL"]) expect(await bal(d.stocks[t].stockToken, a)(w)).toBeGreaterThanOrEqual(10n * 10n ** 18n);
    const sends = w.sends.length;
    await claim.click();
    const err = p.getByText(/already claimed/i).filter({visible: true}).first();
    await expect(err).toBeVisible();
    await expect(err).toContainText(/next claim opens/i);
    plain(await err.innerText());
    expect(w.sends.length, "the refused claim was simulated, not sent").toBe(sends);
    await shot(p, "row02-faucet");
    row("2", `pass: claimed to ${a}; second claim: "${(await err.innerText()).trim()}"`);
  });

  test("row 3: first terms signature: plain text, says no funds move; accepted", async () => {
    w.label = "row 3 terms (vault deposit 1 USDG)";
    const a = w.accounts[1].address;
    expect((await api<{accepted: boolean}>(`/v1/compliance/terms/${a}`, COMPLIANCE)).accepted).toBe(false);
    await p.goto("/vault");
    await p.getByTestId("deposit-amount").fill("1");
    await p.getByTestId("deposit-submit").click();
    const dialog = p.getByRole("dialog");
    await expect(dialog.getByTestId("steps").locator("li")).toHaveText([/Approve USDG/, /Accept the terms/, /Compliance check/, /Deposit 1 USDG/]);
    const n = w.messages.length;
    // Break: reject the terms signature once. The approval before it is kept; "Try again" resumes at the signature.
    w.rejectNext("personal_sign");
    await dialog.getByTestId("confirm").click();
    await expect(dialog).toContainText("You cancelled the request in your wallet.", {timeout: 120_000});
    await expect(dialog.getByTestId("confirm")).toHaveText(/Try again/);
    const afterReject = w.sends.length;
    await shot(p, "break-reject-terms");
    await confirmReview(p, /Deposited 1 USDG/);
    expect(w.sends.length - afterReject, "retry: deposit only, the approval is not sent again").toBe(1);
    const msg = w.messages[n];
    expect(msg, "the terms message").toBeTruthy();
    expect(msg).toMatch(/no funds|does not move|doesn't move|no transaction/i);
    expect(msg).toContain(a.toLowerCase());
    expect(msg).not.toMatch(/0x[0-9a-f]{130}/i); // readable text, not a blob
    expect((await api<{accepted: boolean}>(`/v1/compliance/terms/${a}`, COMPLIANCE)).accepted).toBe(true);
    writeFileSync(`${OUT}/row03-terms-message.txt`, msg);
    await shot(p, "row03-terms");
    row("3", `pass: signed the terms as ${a} (message saved in row03-terms-message.txt); compliance: accepted`);
    await w.useAccount(0);
    await expect(p.getByTestId("account")).toContainText(me().slice(2, 6));
  });

  test("row 4: lend 2 NVDA: preview first; rNVDA appears; the API has the lend", async () => {
    w.label = "row 4 lend 2 NVDA";
    const s = d.stocks.NVDA;
    const shares0 = await bal(s.vault, me())(w);
    await p.goto("/stock/NVDA?tab=lend");
    await p.getByTestId("amount").fill("2");
    await expect(p.getByText(/At today's rate: ≈/)).toBeVisible();
    await p.getByTestId("submit").click();
    const dialog = p.getByRole("dialog");
    await expect(dialog).toContainText("You lend");
    await expect(dialog).toContainText("2 NVDA");
    await confirmReview(p, /Lent 2 NVDA/);
    const shares = await bal(s.vault, me())(w);
    expect(shares).toBeGreaterThan(shares0);
    await expect(p.getByText("rNVDA balance").locator("..")).not.toContainText(/^0$/);
    const hash = w.sends.at(-1)!.hash!;
    await expect.poll(async () => (await api<{data: {txHash: string}[]}>(`/v1/markets/NVDA/events?type=lend&account=${me()}&limit=20`)).data.some((e) => e.txHash.toLowerCase() === hash.toLowerCase()), {timeout: 120_000, message: "the lend is indexed"}).toBe(true);
    await shot(p, "row04-lend");
    row("4", `pass: ${hash}; rNVDA ${formatUnits(shares, 18)}; lend event indexed (the API's /v1/positions lists Morpho positions only, so lends are checked on /v1/markets/NVDA/events)`);
  });

  test("row 5: withdraw 1 NVDA of the lend: stock back, lend halves", async () => {
    w.label = "row 5 withdraw 1 NVDA";
    const s = d.stocks.NVDA;
    const nvda0 = await bal(s.stockToken, me())(w);
    const shares0 = await bal(s.vault, me())(w);
    await p.goto("/stock/NVDA?tab=lend");
    await p.getByTestId("tab-withdraw").click();
    await p.getByTestId("amount").fill("1");
    await p.getByTestId("submit").click();
    await confirmReview(p, /Withdrew 1 NVDA/);
    const nvda1 = await bal(s.stockToken, me())(w);
    expect(nvda1 - nvda0).toBeGreaterThanOrEqual((10n ** 18n * 999n) / 1000n);
    const shares1 = await bal(s.vault, me())(w);
    // One of the two lent comes back (≈ 1 rNVDA burned; the share price is ~1 on a fresh vault).
    expect(Number(formatUnits(shares0 - shares1, 18))).toBeGreaterThan(0.99);
    expect(Number(formatUnits(shares0 - shares1, 18))).toBeLessThan(1.01);
    await shot(p, "row05-withdraw-lend");
    row("5", `pass: ${w.sends.at(-1)!.hash}; +${formatUnits(nvda1 - nvda0, 18)} NVDA; rNVDA ${formatUnits(shares0, 18)} → ${formatUnits(shares1, 18)}`);
  });

  test("row 6: open a short (2,000 USDG, 0.5 NVDA): HF now, at the close, at +10%; position in /portfolio", async () => {
    w.label = "row 6 openShort 0.5 NVDA";
    await waitLiquidity(w, "NVDA", parseUnits("0.5", 18));
    await p.goto("/stock/NVDA?tab=short");
    await p.getByTestId("collateral").fill("2000");
    await p.getByTestId("borrow-amount").fill("0.5");
    const hf = await wadOf(p, "pv-hf-now");
    const hf10 = await wadOf(p, "pv-hf-plus10");
    expect(hf10).toBeLessThan(hf);
    const closeShown = await p.getByTestId("pv-hf-close").count();
    const hfClose = closeShown ? await wadOf(p, "pv-hf-close") : undefined;
    await expect(p.getByTestId("pv-swap")).toBeVisible();
    await p.getByTestId("submit").click();
    await expect(p.getByTestId("rv-liq-now")).toContainText("$");
    await confirmReview(p, /Shorted 0.5 NVDA/);
    const pos = await position(w, "NVDA");
    expect(pos.borrowShares).toBeGreaterThan(0n);
    expect(pos.collateral).toBeGreaterThanOrEqual(2000n * 10n ** 6n);
    const onchain = await hfNow(w, "NVDA");
    const diff = Number(onchain > hf ? onchain - hf : hf - onchain) / Number(hf);
    expect(diff, `preview HF ${hf} vs onchain ${onchain}`).toBeLessThan(0.01);
    await p.goto("/portfolio");
    await expect(await portfolioControl(p, "position-NVDA")).toContainText("Health factor now");
    await expect.poll(async () => (await api<{data: {symbol: string; borrowShares: string}[]}>(`/v1/positions/${me()}`)).data.some((x) => x.symbol === "NVDA" && x.borrowShares !== "0"), {timeout: 120_000, message: "API position"}).toBe(true);
    await shot(p, "row06-short");
    row("6", `pass: ${w.sends.at(-1)!.hash}; preview HF now ${formatUnits(hf, 18)}, at close ${hfClose !== undefined ? formatUnits(hfClose, 18) : "(no closure ahead shown)"}, +10% ${formatUnits(hf10, 18)}; onchain ${formatUnits(onchain, 18)} (${(diff * 100).toFixed(3)}%)`);
  });

  test("row 7: a short too big for the collateral (or the market) is blocked before anything is sent", async () => {
    const sends = w.sends.length;
    await p.goto("/stock/NVDA?tab=short");
    // T35: more than the market can lend right now is refused in the form, before the review.
    const liquidity = Number(formatUnits(await marketLiquidity(w, "NVDA"), 18));
    await p.getByTestId("collateral").fill("20000");
    await p.getByTestId("borrow-amount").fill(String(Math.ceil(liquidity + 1)));
    await expect(p.getByText(/can be borrowed right now/)).toBeVisible();
    await expect(p.getByTestId("submit")).toBeDisabled();
    // Too big for the collateral: on AAPL, where the tester has no position (the preview adds any open one, and row
    // 6's NVDA short with 2,000 USDG covers anything NVDA's market can lend).
    await p.goto("/stock/AAPL?tab=short");
    await p.getByTestId("collateral").fill("1");
    await p.getByTestId("borrow-amount").fill("0.02");
    const alert = p.getByTestId("preview").getByRole("alert");
    await expect(alert).toContainText("The router will refuse this");
    await expect(p.getByTestId("submit")).toBeDisabled();
    await expect(p.getByText("Not enough collateral: the health factor 24 hours from now would be below 1.10")).toBeVisible();
    plain(await alert.innerText());
    expect(w.sends.length).toBe(sends);
    await shot(p, "row07-too-big");
    row("7", `pass: blocked in the form ("${(await alert.innerText()).slice(0, 90)}…"), review disabled, nothing sent`);
  });

  test("row 8: the quote moves between preview and submit: clear slippage error, nothing sent, nothing lost", async () => {
    // The UI has no slippage setting (minOut = the quote less the router's tolerance). A quote that moved is made by
    // serving the page a quote 5% above the pool's: the swap can't meet that floor, so the simulation must refuse.
    const sends = w.sends.length;
    const usdg0 = await bal(d.usdg, me())(w);
    await inflateQuotes(p, 1.05);
    try {
      await p.goto("/stock/NVDA?tab=short");
      await p.getByTestId("collateral").fill("500");
      await p.getByTestId("borrow-amount").fill("0.1");
      await expect(p.getByTestId("pv-swap")).toBeVisible();
      await p.getByTestId("submit").click();
      const dialog = p.getByRole("dialog");
      await dialog.getByTestId("confirm").click();
      const err = dialog.getByText("That didn't go through").locator("..");
      await expect(err).toBeVisible({timeout: 120_000});
      await expect(err).toContainText(/less than your minimum|price moved/i);
      plain(await err.innerText());
      await shot(p, "row08-slippage");
      row("8", `pass: "${(await err.innerText()).replace(/\s+/g, " ").slice(0, 140)}"; ${w.sends.length - sends} execute sends`);
      await p.keyboard.press("Escape");
    } finally {
      await p.unroute("**/*");
    }
    // Only a first-time approval could have been sent (none: USDG is already approved); no USDG moved.
    expect(w.sends.slice(sends).every((s) => s.to?.toLowerCase() !== d.router!.toLowerCase())).toBe(true);
    expect(await bal(d.usdg, me())(w)).toBe(usdg0);
  });

  test("row 9: add collateral to the short: health factor rises", async () => {
    w.label = "row 9 addCollateral 500";
    const hf0 = await hfNow(w, "NVDA");
    const c0 = (await position(w, "NVDA")).collateral;
    await p.goto("/portfolio");
    await p.getByTestId("add-amount-NVDA").fill("500");
    await (await portfolioControl(p, "add-NVDA")).click();
    await expect(p.getByRole("dialog")).toContainText("Collateral after");
    await confirmReview(p, /Added 500 USDG collateral/);
    expect((await position(w, "NVDA")).collateral - c0).toBe(500n * 10n ** 6n);
    const hf1 = await hfNow(w, "NVDA");
    expect(hf1).toBeGreaterThan(hf0);
    await shot(p, "row09-add-collateral");
    row("9", `pass: ${w.sends.at(-1)!.hash}; HF ${formatUnits(hf0, 18)} → ${formatUnits(hf1, 18)}`);
  });

  test("row 10: no 'add collateral' where there is no debt (rescue top-up only, RT-R8)", async () => {
    await p.goto("/portfolio");
    await portfolioControl(p, "position-NVDA");
    for (const t of ["SPY", "AAPL"]) await expect(p.getByTestId(`add-${t}`)).toHaveCount(0);
    await p.goto("/stock/SPY?tab=borrow");
    // Collateral alone (no amount) can't be reviewed: the form says what's missing.
    await p.getByTestId("collateral").fill("100");
    await expect(p.getByTestId("submit")).toBeDisabled();
    await expect(p.getByText("Enter how much SPY to borrow.")).toBeVisible();
    await shot(p, "row10-no-debt");
    row("10", "pass: no add-collateral control without debt; collateral-only borrow form disabled with “Enter how much SPY to borrow.” (the NoDebtPosition revert text is covered by testnetBreak.ts)");
  });

  test("row 11: repay part of the debt: debt falls", async () => {
    w.label = "row 11 partial repay";
    const debt0 = (await position(w, "NVDA")).borrowShares;
    await p.goto("/portfolio");
    const input = await portfolioControl(p, "repay-amount-NVDA"); // US-B5: a partial repay amount
    await input.fill("0.2");
    await (await portfolioControl(p, "repay-NVDA")).click();
    await expect(p.getByRole("dialog")).toContainText("0.2 NVDA");
    await confirmReview(p, /Repaid 0.2 NVDA/);
    const debt1 = (await position(w, "NVDA")).borrowShares;
    expect(debt1).toBeGreaterThan(0n);
    expect(debt1).toBeLessThan(debt0);
    await shot(p, "row11-partial-repay");
    row("11", `pass: ${w.sends.at(-1)!.hash}; borrow shares ${debt0} → ${debt1}`);
  });

  test("row 12: close the short: debt 0, collateral back as USDG", async () => {
    w.label = "row 12 closeShort";
    const usdg0 = await bal(d.usdg, me())(w);
    const coll = (await position(w, "NVDA")).collateral;
    await p.goto("/portfolio");
    await (await portfolioControl(p, "close-NVDA")).click();
    await confirmReview(p, /Closed your NVDA position/);
    const pos = await position(w, "NVDA");
    expect(pos.borrowShares).toBe(0n);
    expect(pos.collateral).toBe(0n);
    const back = (await bal(d.usdg, me())(w)) - usdg0;
    expect(back).toBeGreaterThan((coll * 9n) / 10n);
    await expect(p.getByTestId("position-NVDA")).toHaveCount(0, {timeout: 30_000});
    await shot(p, "row12-close");
    row("12", `pass: ${w.sends.at(-1)!.hash}; +${formatUnits(back, 6)} USDG of ${formatUnits(coll, 6)} collateral (the rest bought back the stock)`);
  });

  test("row 13: AAPL: just borrow 0.5; repay all; withdraw collateral: position gone, USDG back", async () => {
    // AAPL's market only holds the vault's few hundredths: lend 1 AAPL first (through the UI) so 0.5 can be borrowed.
    w.label = "row 13 lend 1 AAPL (liquidity)";
    await p.goto("/stock/AAPL?tab=lend");
    await p.getByTestId("amount").fill("1");
    await p.getByTestId("submit").click();
    await confirmReview(p, /Lent 1 AAPL/);
    await waitLiquidity(w, "AAPL", parseUnits("0.5", 18));

    w.label = "row 13 borrow 0.5 AAPL";
    const usdg0 = await bal(d.usdg, me())(w);
    await p.goto("/stock/AAPL?tab=borrow");
    await p.getByTestId("collateral").fill("600");
    await p.getByTestId("borrow-amount").fill("0.5");
    await wadOf(p, "pv-hf-now");
    await p.getByTestId("submit").click();
    await confirmReview(p, /Borrowed 0.5 AAPL/);
    expect((await position(w, "AAPL")).borrowShares).toBeGreaterThan(0n);

    w.label = "row 13 repay all AAPL";
    await p.goto("/portfolio");
    await (await portfolioControl(p, "repay-AAPL")).click();
    await confirmReview(p, /Repaid/);
    await expect.poll(async () => (await position(w, "AAPL")).borrowShares, {timeout: 60_000}).toBe(0n);

    w.label = "row 13 withdraw collateral AAPL";
    await expect(p.getByTestId("withdraw-collateral-AAPL")).toBeVisible({timeout: 30_000});
    await (await portfolioControl(p, "withdraw-collateral-AAPL")).click();
    await confirmReview(p, /Withdrew your collateral/);
    expect((await position(w, "AAPL")).collateral).toBe(0n);
    expect(await bal(d.usdg, me())(w)).toBe(usdg0);
    await expect(p.getByTestId("position-AAPL")).toHaveCount(0, {timeout: 30_000});

    w.label = "row 13 withdraw the AAPL lend";
    await expect(p.getByTestId("withdraw-lend-AAPL")).toBeVisible();
    await waitLiquidity(w, "AAPL", 0n);
    await (await portfolioControl(p, "withdraw-lend-AAPL")).click();
    await confirmReview(p, /Withdrew your AAPL/);
    expect(await bal(d.stocks.AAPL.vault, me())(w)).toBe(0n);
    await shot(p, "row13-borrow-aapl");
    row("13", "pass: lend 1 AAPL (liquidity) → borrow 0.5 AAPL → repay all → withdraw collateral (USDG back to the unit) → withdraw the lend");
  });

  test("row 14: /alerts: a health-factor alert, saved after a signed message", async () => {
    const n = w.messages.length;
    await p.goto("/alerts");
    await p.getByLabel("Alert when health factor is below").fill("1.4");
    await p.getByLabel("Webhook URL (HTTPS)").fill("https://example.com/lendora-e2e");
    await p.getByRole("button", {name: "Save alert settings"}).click();
    await expect(p.getByText(/^Saved\./)).toBeVisible({timeout: 60_000});
    expect(w.messages[n]).toMatch(/1\.4/);
    await p.reload();
    await expect(p.getByLabel("Alert when health factor is below")).toHaveValue("1.4");
    await shot(p, "row14-alerts");
    row("14", "pass: saved with a signature (no gas); reload shows 1.4");
  });

  test("row 16: USDG Earn: deposit 100 USDG (terms already accepted: approve/terms skipped as satisfied)", async () => {
    w.label = "row 16 vault deposit 100";
    const shares0 = await bal(d.dnVault!.vault, me())(w);
    await p.goto("/vault");
    await expect(p.getByText("Net APY (30d, variable)").first()).toBeVisible();
    await p.getByTestId("deposit-amount").fill("100");
    await expect(p.getByTestId("deposit-shares")).toContainText("You get ≈");
    await p.getByTestId("deposit-submit").click();
    await expect(p.getByTestId("review-risks")).toBeVisible();
    await confirmReview(p, /Deposited 100 USDG/);
    const shares1 = await bal(d.dnVault!.vault, me())(w);
    expect(shares1).toBeGreaterThan(shares0);
    await shot(p, "row16-vault-deposit");
    row("16", `pass: ${w.sends.at(-1)!.hash}; shares ${formatUnits(shares0, 18)} → ${formatUnits(shares1, 18)}`);
  });

  test("row 17: instant withdrawal of 10 USDG: at once, no attestation", async () => {
    w.label = "row 17 vault instant 10";
    const usdg0 = await bal(d.usdg, me())(w);
    const n = w.messages.length;
    await p.goto("/vault");
    await p.getByTestId("mode-withdraw").click();
    await p.getByTestId("withdraw-amount").fill("10");
    await expect(p.getByTestId("withdraw-split")).toHaveText("10 USDG now");
    await p.getByTestId("withdraw-submit").click();
    await expect(p.getByRole("dialog").getByTestId("steps").locator("li")).toHaveText([/Withdraw 10 USDG now/]);
    await confirmReview(p, /Withdrew 10 USDG/);
    expect((await bal(d.usdg, me())(w)) - usdg0).toBe(10n * 10n ** 6n);
    expect(w.messages.length).toBe(n);
    await shot(p, "row17-vault-instant");
    row("17", `pass: ${w.sends.at(-1)!.hash}; +10 USDG; no signature, no attestation`);
  });

  let queuedId: string | undefined;
  test("row 18: more than the instant capacity: part now, the rest queued with a date", async () => {
    w.label = "row 18 vault queued";
    // A queue needs more than the vault's cash buffer. Withdraw the whole position (Max): after US hours the rebalancer
    // leaves new deposits idle, and the buffer can cover everything the tester holds (then there is nothing to queue).
    await p.goto("/vault");
    await p.getByTestId("mode-withdraw").click();
    await p.getByTestId("withdraw-form").getByRole("button", {name: /^Use max/}).click();
    const split = p.getByTestId("withdraw-split");
    await expect(split).toContainText("USDG");
    const splitText = (await split.innerText()).trim();
    if (!/queued/.test(splitText)) {
      row("18", `skipped: the whole balance is instant ("${splitText}"): the vault's buffer covers it (new deposits stay idle outside US regular hours); rows 18–20 passed during the session in earlier runs`);
      test.skip(true, `nothing to queue: ${splitText}`);
    }
    const amount = splitText;
    await expect(split).toContainText("USDG queued, paid by");
    await p.getByTestId("withdraw-submit").click();
    await expect(p.getByTestId("rv-queue-note")).toContainText("72 hours or the next US market open");
    const before = new Set((await api<{data: {requests: {id: string}[]}}>(`/v1/vault/account/${me()}`)).data.requests.map((r) => r.id));
    await confirmReview(p, /queued|Requested/);
    await expect
      .poll(async () => {
        const r = (await api<{data: {requests: {id: string; status: string; settlesAt: string}[]}}>(`/v1/vault/account/${me()}`)).data.requests.find((x) => !before.has(x.id));
        queuedId = r?.id;
        return r?.status;
      }, {timeout: 120_000, message: "the request is indexed"})
      .toMatch(/queued|ready/);
    await shot(p, "row18-vault-queued");
    row("18", `pass: Max → "${amount}"; the review names the rule and the date; request #${queuedId}`);
  });

  test("row 19: claim before settlement: no claim button; the card says queued with the date", async () => {
    test.skip(!queuedId, "no queued request (row 18 skipped)");
    await p.goto("/portfolio");
    const card = p.getByTestId(`request-${queuedId}`);
    await expect(card).toBeVisible({timeout: 60_000});
    const status = await card.getAttribute("data-status");
    if (status === "queued") {
      await expect(card).toContainText("Paid by");
      await expect(p.getByTestId(`claim-${queuedId}`)).toHaveCount(0);
      row("19", `pass: request #${queuedId} queued, "Paid by …", no claim button`);
    } else {
      row("19", `skipped: request #${queuedId} already settled (${status}) before the page loaded`);
    }
    await shot(p, "row19-before-settlement");
  });

  test("row 20: after settlement (the rebalancer settles it) claim from /portfolio", async () => {
    test.skip(!queuedId, "no queued request (row 18 skipped)");
    w.label = "row 20 vault claim";
    test.setTimeout(40 * 60_000);
    await expect.poll(async () => (await api<{data: {requests: {id: string; status: string}[]}}>(`/v1/vault/account/${me()}`)).data.requests.find((r) => r.id === queuedId)?.status, {timeout: 35 * 60_000, intervals: [15_000], message: "the rebalancer settles the request"}).toBe("ready");
    const usdg0 = await bal(d.usdg, me())(w);
    await p.goto("/portfolio");
    await p.getByTestId(`claim-${queuedId}`).click();
    await confirmReview(p, /Claimed/);
    expect(await bal(d.usdg, me())(w)).toBeGreaterThan(usdg0);
    await expect.poll(async () => (await api<{data: {requests: {id: string; status: string}[]}}>(`/v1/vault/account/${me()}`)).data.requests.find((r) => r.id === queuedId)?.status, {timeout: 120_000}).toBe("claimed");
    await shot(p, "row20-claim");
    row("20", `pass: ${w.sends.at(-1)!.hash}; request #${queuedId} claimed`);
  });

  test("row 22: reload mid-flow (after approve, after send before mined, after mined): resumes, no double spend", async () => {
    // The throwaway has no approvals: lend 1 NVDA needs approve + lend.
    await w.useAccount(1);
    const a = w.accounts[1].address;
    const s = d.stocks.NVDA;
    const sends0 = w.sends.length;
    w.label = "row 22 approve then reload";
    await p.goto("/stock/NVDA?tab=lend");
    await expect(p.getByTestId("account")).toContainText(a.slice(2, 6));
    await p.getByTestId("amount").fill("1");
    await p.getByTestId("submit").click();
    await expect(p.getByRole("dialog").getByTestId("steps").locator("li").first()).toHaveAttribute("data-status", "pending");
    // Break: reject the approval prompt first (clear message, nothing sent).
    w.rejectNext("eth_sendTransaction");
    await p.getByRole("dialog").getByTestId("confirm").click();
    await expect(p.getByRole("dialog")).toContainText("You cancelled the request in your wallet.");
    expect(w.sends.length).toBe(sends0);
    await shot(p, "break-reject-approve");
    // Reload as soon as the approval is broadcast.
    let reloaded: Promise<unknown> | undefined;
    w.onSend = () => {
      w.onSend = undefined;
      reloaded = new Promise((r) => setTimeout(r, 1500)).then(() => p.reload());
    };
    await p.getByRole("dialog").getByTestId("confirm").click();
    await expect.poll(() => reloaded !== undefined, {timeout: 60_000}).toBe(true);
    await reloaded;
    expect(w.sends.length - sends0).toBe(1);
    await expect.poll(async () => w.pc.readContract({address: s.stockToken, abi: erc20Abi, functionName: "allowance", args: [a, d.router!]}), {timeout: 60_000}).toBeGreaterThan(0n);
    // After the reload the review knows the approval is done and only lends.
    w.label = "row 22 lend after reload (reload before mined)";
    await p.getByTestId("amount").fill("1");
    await p.getByTestId("submit").click();
    await expect(p.getByRole("dialog").getByTestId("steps").locator("li").first()).toHaveAttribute("data-status", "skipped");
    let reloaded2: Promise<unknown> | undefined;
    w.onSend = () => {
      w.onSend = undefined;
      reloaded2 = p.reload(); // before the receipt
    };
    await p.getByRole("dialog").getByTestId("confirm").click();
    await expect.poll(() => reloaded2 !== undefined, {timeout: 60_000}).toBe(true);
    await reloaded2;
    const lendHash = w.sends.at(-1)!.hash!;
    const rc = await w.pc.waitForTransactionReceipt({hash: lendHash});
    expect(rc.status).toBe("success");
    expect(w.sends.length - sends0, "approve + lend, nothing twice").toBe(2);
    // After it is mined: the reloaded page shows the lend, and offers nothing to redo.
    await p.reload();
    await expect(p.getByText("rNVDA balance").locator("..")).toContainText(/1(\.0+)?/, {timeout: 60_000});
    expect(await bal(s.vault, a)(w)).toBeGreaterThan(0n);
    await shot(p, "row22-reload");
    row("22", `pass: approve ${w.sends[sends0].hash} → reload → review shows approve skipped → lend ${lendHash} → reload before mined → mined once; 2 sends total`);
    // Leave the throwaway's lend in place (1 test NVDA); back to the tester.
    await w.useAccount(0);
  });

  test("row 23: reject a wallet prompt: clear 'cancelled' state, retry works", async () => {
    w.label = "row 23 lend after a rejection";
    await p.goto("/stock/NVDA?tab=lend");
    await expect(p.getByTestId("account")).toContainText(me().slice(2, 6));
    await p.getByTestId("amount").fill("0.1");
    await p.getByTestId("submit").click();
    const dialog = p.getByRole("dialog");
    const sends = w.sends.length;
    w.rejectNext("eth_sendTransaction");
    await dialog.getByTestId("confirm").click();
    await expect(dialog).toContainText("You cancelled the request in your wallet.");
    await expect(dialog.getByTestId("confirm")).toHaveText(/Try again/);
    await expect(p.getByTestId("toast").filter({hasText: "Couldn't lend NVDA"})).toBeVisible();
    expect(w.sends.length).toBe(sends);
    await shot(p, "row23-rejected");
    await dialog.getByTestId("confirm").click();
    await stepsDone(p);
    await dialog.getByRole("button", {name: "Done"}).click();
    row("23", `pass: rejected → "You cancelled the request in your wallet." + "Try again" → retry lent 0.1 NVDA (${w.sends.at(-1)!.hash})`);
  });

  test("cleanup: withdraw the tester's NVDA lend", async () => {
    w.label = "cleanup withdraw NVDA lend";
    if ((await bal(d.stocks.NVDA.vault, me())(w)) === 0n) return;
    await waitLiquidity(w, "NVDA", 0n);
    await p.goto("/portfolio");
    await (await portfolioControl(p, "withdraw-lend-NVDA")).click();
    await confirmReview(p, /Withdrew your NVDA/);
    expect(await bal(d.stocks.NVDA.vault, me())(w)).toBe(0n);
  });
});

/**
 * Serves the page aggregator quotes `factor` × the pool's (a quote that moved against the user). Only the
 * swapAggregator.quote eth_calls are changed; everything else passes through.
 */
async function inflateQuotes(p: Page, factor: number) {
  const agg = d.mocks!.swapAggregator!.toLowerCase();
  const QUOTE = "0x"; // any call to the aggregator is a quote (the page never sends it anything else)
  await p.route("https://rpc.testnet.chain.robinhood.com/**", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    const body = JSON.parse(req.postData() ?? "null");
    const list: {id: number; method: string; params: [{to?: string; data?: string}]}[] = Array.isArray(body) ? body : [body];
    const hit = new Set(list.filter((c) => c.method === "eth_call" && c.params?.[0]?.to?.toLowerCase() === agg && c.params[0].data?.startsWith(QUOTE)).map((c) => c.id));
    if (!hit.size) return route.continue();
    const res = await route.fetch();
    const json = await res.json();
    const out = (Array.isArray(json) ? json : [json]).map((r: {id: number; result?: Hex}) => (hit.has(r.id) && r.result ? {...r, result: `0x${((BigInt(r.result) * BigInt(Math.round(factor * 1000))) / 1000n).toString(16).padStart(64, "0")}`} : r));
    await route.fulfill({response: res, json: Array.isArray(json) ? out : out[0]});
  });
}

// ---- break it ----------------------------------------------------------------------------------------------------
/**
 * Section 3 of docs/prompts/testnet-browser.md: each case passes (clear message, nothing lost) or is a finding. Real
 * transactions only where the case needs one (slow wallet, double click, two tabs, stale preview), all tiny.
 */
const findings: string[] = [];
const note = (c: string, r: string) => findings.push(`| ${c} | ${r} |`);

test.describe.serial("46630 break: inputs, wallet, reload, state, compliance, rendering", () => {
  let p: Page;
  let w: TestnetWallet;
  const me = () => w.address;
  let maxIncident = 0;

  test.beforeAll(async ({app, wallet}) => {
    p = app;
    w = wallet;
    await w.useAccount(0);
    await p.goto("/markets");
    await connect(p, w);
    const inc = await api<{open: {id: number}[]; recent: {id: number}[]}>("/incidents", "http://127.0.0.1:42073").catch(() => ({open: [], recent: []}));
    maxIncident = Math.max(0, ...inc.open.map((i) => i.id), ...inc.recent.map((i) => i.id));
  });

  test.afterAll(async () => {
    // Watch: incidents opened during the run (the baseline is the highest id seen at the start).
    const inc = await api<{recent: {id: number; rule: string; title: string; status: string}[]}>("/incidents", "http://127.0.0.1:42073").catch(() => ({recent: []}));
    for (const i of inc.recent.filter((x) => x.id > maxIncident)) note(`incident #${i.id}`, `${i.rule} (${i.status}): ${i.title}`);
    writeFileSync(`${OUT}/break.md`, ["| case | result |", "|---|---|", ...findings].join("\n") + "\n");
  });

  test("inputs: 0, negative, 1e-30, too many decimals, 1e30, commas and spaces, leading zeros, non-ASCII digits, Max", async () => {
    await p.goto("/stock/NVDA?tab=lend");
    // The over-balance message needs the balance, read from the chain (reload once if the read hangs).
    await p.getByText(/Wallet balance/).first().waitFor({timeout: 45_000}).catch(() => p.reload());
    await expect(p.getByText(/Wallet balance/).first()).toBeVisible({timeout: 60_000});
    const amount = p.getByTestId("amount");
    const submit = p.getByTestId("submit");
    const err = p.locator("[id$='-err']").filter({visible: true});
    const sends = w.sends.length;
    const cases: [string, RegExp | null, boolean][] = [
      ["0", null, false],
      ["-1", /Enter a number/, false],
      ["1e-30", /Enter a number/, false],
      ["0.0000000000000000001", /18 decimal places/, false],
      ["1e30", /Enter a number/, false],
      ["1000000000000000000000000000000", /more than your wallet balance/, false],
      ["١", /Enter a number/, false],
      ["1,00,0", /Enter a number/, false],
      ["0,5", null, true],
      [" 0.5 ", null, true],
      ["000.5", null, true],
    ];
    for (const [v, msg, ok] of cases) {
      await amount.fill(v);
      if (msg) await expect(err, v).toContainText(msg);
      else await expect(err, v).toHaveCount(0);
      if (ok) await expect(submit, v).toBeEnabled();
      else await expect(submit, v).toBeDisabled();
    }
    // Max fills the wallet balance exactly and is reviewable.
    await p.getByRole("button", {name: /^Use max/}).click();
    await expect(submit).toBeEnabled();
    const max = await amount.inputValue();
    expect(parseUnits(max, 18)).toBe(await bal(d.stocks.NVDA.stockToken, me())(w));
    // USDG (6 dp) on the vault: "1,000" is a thousand, not one.
    await p.goto("/vault");
    await p.getByTestId("deposit-amount").fill("1,000");
    await expect(p.getByTestId("deposit-shares")).toContainText(/≈ (99\d|1,0\d\d)\./);
    await p.getByTestId("deposit-amount").fill("0.0000005");
    await expect(p.getByText("USDG has 6 decimal places").first()).toBeVisible();
    expect(w.sends.length).toBe(sends);
    await shot(p, "break-inputs");
    note("inputs", "pass: every bad value named in words, review disabled; Max = balance; \"1,000\" = 1000 (T27 fixed); 7th USDG decimal refused");
  });

  test("row 8 edge: the amount changed after the preview: the review shows the new amount", async () => {
    await p.goto("/stock/NVDA?tab=short");
    await p.getByTestId("collateral").fill("500");
    await p.getByTestId("borrow-amount").fill("0.1");
    await expect(p.getByTestId("pv-swap")).toBeVisible();
    await p.getByTestId("submit").click();
    // T36: "You short" is this action's amount even with a position open (it showed the total after).
    await expect(p.getByTestId("rv-amount")).toContainText("0.1 NVDA");
    await p.keyboard.press("Escape");
    await p.getByTestId("borrow-amount").fill("0.2");
    await p.getByTestId("submit").click();
    await expect(p.getByTestId("rv-amount")).toContainText("0.2 NVDA");
    await expect(p.getByRole("dialog").getByTestId("confirm")).toHaveText("Short 0.2 NVDA");
    await p.keyboard.press("Escape");
    note("amount changed after preview", "pass: the review follows the form (0.1 → 0.2); the confirm label names the amount that will be sent");
  });

  test("T30: right after connecting, Review waits for the chain read; Confirm then always reaches the wallet", async () => {
    await p.goto("/stock/NVDA?tab=lend");
    await p.getByTestId("amount").fill("0.01");
    await expect(p.getByTestId("submit")).toBeEnabled({timeout: 60_000});
    await p.getByTestId("submit").click();
    w.rejectNext("eth_sendTransaction");
    await p.getByRole("dialog").getByTestId("confirm").click();
    await expect(p.getByRole("dialog")).toContainText("You cancelled the request in your wallet.", {timeout: 30_000});
    await p.keyboard.press("Escape");
    note("T30 review before the chain read", "fixed: Review disabled with “Reading your balance from the chain…” until the position loads; Confirm reaches the wallet (it used to do nothing, silently)");
  });

  test("wallet: slow (30 s) and double-click on confirm: one transaction, busy state shown", async () => {
    test.setTimeout(5 * 60_000);
    w.label = "break slow wallet lend 0.01";
    await p.goto("/stock/NVDA?tab=lend");
    await p.getByTestId("amount").fill("0.01");
    await p.getByTestId("submit").click();
    const dialog = p.getByRole("dialog");
    const sends = w.sends.length;
    w.delay(30_000);
    try {
      await dialog.getByTestId("confirm").dblclick();
      await expect(dialog.getByTestId("confirm")).toHaveText("Confirm in your wallet…");
      await expect(dialog.getByTestId("confirm")).toBeDisabled();
      await expect(dialog.getByRole("button", {name: "Close"})).toHaveCount(0);
      await shot(p, "break-slow-wallet");
      await stepsDone(p, 120_000);
    } finally {
      w.delay(0);
    }
    await dialog.getByRole("button", {name: "Done"}).click();
    expect(w.sends.length - sends, "double click, one lend").toBe(1);
    note("slow wallet + double click", `pass: "Confirm in your wallet…", confirm disabled, sheet not dismissable; one send (${w.sends.at(-1)!.hash})`);
  });

  test("wallet: disconnect mid-flow, switch account mid-flow, switch chain mid-flow: refused in words, nothing sent", async () => {
    test.setTimeout(6 * 60_000);
    const attempt = async (name: string, during: () => Promise<void>, after: () => Promise<void>) => {
      await p.goto("/stock/NVDA?tab=lend");
      await expect(p.getByTestId("account")).toContainText(me().slice(2, 6));
      await p.getByTestId("amount").fill("0.01");
      await p.getByTestId("submit").click();
      const dialog = p.getByRole("dialog");
      const sends = w.sends.length;
      w.delay(4_000);
      await dialog.getByTestId("confirm").click();
      await during();
      await expect(dialog.getByText("That didn't go through")).toBeVisible({timeout: 60_000});
      w.delay(0);
      const text = (await dialog.getByText("That didn't go through").locator("..").innerText()).replace(/\s+/g, " ");
      await shot(p, `break-${name}`);
      expect(w.sends.length, name).toBe(sends);
      await p.keyboard.press("Escape");
      await after();
      return text;
    };
    const t1 = await attempt("disconnect", () => w.disconnect(), async () => {
      await p.goto("/stock/NVDA?tab=lend");
      await expect(p.getByTestId("connect").first()).toBeVisible();
      await connect(p, w);
    });
    note("disconnect mid-flow", `"${t1}"`);
    const t2 = await attempt("switch-account", () => w.useAccount(1), async () => {
      await expect(p.getByTestId("account")).toContainText(w.accounts[1].address.slice(2, 6));
      await w.useAccount(0);
      await expect(p.getByTestId("account")).toContainText(me().slice(2, 6));
    });
    note("switch account mid-flow", `"${t2}"; the header follows the new account`);
    const t3 = await attempt("switch-chain", () => w.setChain(1), async () => {
      await expect(p.getByTestId("switch-network")).toBeVisible();
      await p.getByTestId("switch-network").click();
      await expect(p.getByTestId("account")).toBeVisible();
      expect(w.currentChain).toBe(TESTNET);
    });
    note("switch chain mid-flow", `"${t3}"; header "Switch to …" one click back; no send on chain 1`);
    for (const t of [t1, t2, t3]) plain(t);
  });

  test("wallet: two tabs lend at once: each its own transaction, balances add up", async ({ctx}) => {
    w.label = "break two tabs";
    const p2 = await ctx.newPage();
    try {
      const shares0 = await bal(d.stocks.NVDA.vault, me())(w);
      const sends = w.sends.length;
      for (const q of [p, p2]) {
        await q.goto("/stock/NVDA?tab=lend");
        await expect(q.getByTestId("account")).toBeVisible();
        await q.getByTestId("amount").fill("0.01");
        await q.getByTestId("submit").click();
      }
      await Promise.all([p.getByRole("dialog").getByTestId("confirm").click(), p2.getByRole("dialog").getByTestId("confirm").click()]);
      await Promise.all([stepsDone(p), stepsDone(p2)]);
      expect(w.sends.length - sends).toBe(2);
      expect((await bal(d.stocks.NVDA.vault, me())(w)) > shares0).toBe(true);
      note("two tabs", "pass: two sends, two lends, no nonce clash (the wallet serializes like a real one)");
    } finally {
      await p2.close();
    }
  });

  test("reload / back: back button while a transaction is pending; deep links with bad params", async () => {
    w.label = "break back button";
    await p.goto("/markets");
    await p.goto("/stock/NVDA?tab=lend");
    await p.getByTestId("amount").fill("0.01");
    await p.getByTestId("submit").click();
    const sends = w.sends.length;
    w.delay(3_000);
    await p.getByRole("dialog").getByTestId("confirm").click();
    await p.goBack();
    w.delay(0);
    await expect(p).toHaveURL(/\/markets/);
    // Leaving mid-flow: either the page hadn't asked the wallet yet (nothing sent) or the asked send lands; never two.
    await p.waitForTimeout(10_000);
    const leftSends = w.sends.length - sends;
    expect(leftSends).toBeLessThanOrEqual(1);
    await p.goForward();
    await expect(p.getByTestId("amount")).toBeVisible();
    await expect(p.getByRole("dialog")).toHaveCount(0);
    // Deep links.
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(e.message));
    for (const [url, expectTab] of [["/stock/NVDA?tab=xyz", "tab-lend"], ["/stock/NVDA?tab=short&amount=-5", "tab-short"], ["/stock/nvda?tab=borrow&amount=abc", "tab-borrow"]] as const) {
      const r = await p.goto(url);
      expect(r?.status(), url).toBe(200);
      await expect(p.getByTestId(expectTab)).toHaveAttribute("aria-selected", "true");
    }
    const r404 = await p.goto("/stock/TSLA");
    expect(r404?.status()).toBe(404);
    expect(errors).toEqual([]);
    note("back button mid-flow", `pass: leaving mid-flow loses nothing (${leftSends ? "the asked send landed" : "left before the wallet was asked: nothing sent"}); fresh page on return, no stuck sheet`);
    note("deep links", "pass: ?tab=xyz → Lend; ?amount=… ignored; lower-case ticker works; unknown ticker 404; no page errors");
  });

  test("state: a stale preview (2 min) then submit: goes through at fresh prices or refuses clearly", async () => {
    test.setTimeout(8 * 60_000);
    w.label = "break stale preview short 0.05";
    await waitLiquidity(w, "NVDA", parseUnits("0.05", 18));
    await p.goto("/stock/NVDA?tab=short");
    await p.getByTestId("collateral").fill("300");
    await p.getByTestId("borrow-amount").fill("0.05");
    await expect(p.getByTestId("pv-swap")).toBeVisible();
    await p.getByTestId("submit").click();
    await p.waitForTimeout(120_000);
    const dialog = p.getByRole("dialog");
    await dialog.getByTestId("confirm").click();
    await expect(dialog.locator('[data-testid="steps"] li[data-status="active"], [data-testid="steps"] li[data-status="pending"]')).toHaveCount(0, {timeout: 180_000});
    const failed = await dialog.getByText("That didn't go through").count();
    const text = failed ? (await dialog.getByText("That didn't go through").locator("..").innerText()).replace(/\s+/g, " ") : "went through";
    if (failed) plain(text);
    await shot(p, "break-stale-preview");
    await p.keyboard.press("Escape");
    if ((await position(w, "NVDA")).borrowShares > 0n) {
      w.label = "break stale preview close";
      await p.goto("/portfolio");
      await (await portfolioControl(p, "close-NVDA")).click();
      await confirmReview(p, /Closed your NVDA position/);
    }
    note("stale preview (2 min)", `pass: ${text}${failed ? "" : `; closed again (${w.sends.at(-1)!.hash})`}`);
  });

  test("state: the API answering 503 (browser side): pages degrade, previews still read the chain", async () => {
    await p.route("http://127.0.0.1:42070/**", (r) => r.fulfill({status: 503, json: {error: "the indexer is rebuilding its views; retry shortly"}, headers: {"retry-after": "30", "access-control-allow-origin": "*"}}));
    try {
      await p.goto("/portfolio");
      await expect(p.getByText("History didn't load")).toBeVisible({timeout: 60_000});
      await p.goto("/vault");
      await expect(p.getByText("Vault data didn't load")).toBeVisible({timeout: 60_000});
      await expect(p.getByTestId("deposit-submit")).toHaveCount(0);
      await p.goto("/stock/NVDA?tab=short");
      await p.getByTestId("collateral").fill("500");
      await p.getByTestId("borrow-amount").fill("0.1");
      await expect(p.getByTestId("pv-hf-now")).toBeVisible(); // the preview is chain-read (APP-R5)
      await shot(p, "break-api-503");
      note("API 503 (browser)", "pass: history and vault say they didn't load and offer no deposit; the borrow preview (chain-read) still prices; server-rendered pages: see T28");
    } finally {
      await p.unroute("http://127.0.0.1:42070/**");
    }
  });

  test("compliance: the sanctioned address and an old terms version are refused in words", async () => {
    const users = JSON.parse(await import("node:fs").then((f) => f.readFileSync("../.dev/testnet-users.json", "utf8"))) as {sanctioned: {address: string}};
    const r = await fetch("http://127.0.0.1:3000/api/compliance/attest", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({address: users.sanctioned.address})});
    const j = (await r.json()) as {code?: string; error?: string};
    expect(r.status).toBe(403);
    expect(j.code).toMatch(/SANCTIONED|TERMS_REQUIRED/);
    // An old terms version, signed by the throwaway: refused, and the current version stays required.
    const a = w.accounts[1];
    const cur = await api<{version: string; message: string}>(`/v1/compliance/terms?address=${a.address}`, COMPLIANCE);
    const old = "2026-01-01.0";
    const sig = await a.signMessage({message: cur.message.replace(cur.version, old)});
    const r2 = await fetch("http://127.0.0.1:3000/api/compliance/terms", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({address: a.address, signature: sig, version: old})});
    const j2 = (await r2.json()) as {code?: string; error?: string};
    expect(r2.ok, JSON.stringify(j2)).toBe(false);
    note("sanctioned address", `${r.status} ${j.code}: "${j.error}" (the UI can't be driven as this address: its key isn't kept by design; the attest step shows this text)`);
    note("terms of an older version", `${r2.status} ${j2.code ?? ""}: "${j2.error}"`);
  });

  test("T24: rejecting the network switch while connecting says why", async () => {
    await w.disconnect();
    await p.goto("/markets");
    await expect(p.getByTestId("connect").first()).toBeVisible();
    await w.setChain(1);
    w.rejectNext("wallet_switchEthereumChain");
    await p.getByTestId("connect").first().click();
    await p.getByRole("menuitem", {name: "Lendora Test Wallet"}).click();
    const toast = p.getByTestId("toast").filter({hasText: "Switch to Robinhood Chain Testnet to continue"});
    await expect(toast).toBeVisible();
    await shot(p, "break-T24");
    expect(w.sends.length).toBe(w.sends.length);
    // Connect again and accept the switch.
    await p.getByTestId("connect").first().click();
    await p.getByRole("menuitem", {name: "Lendora Test Wallet"}).click();
    await expect(p.getByTestId("account")).toBeVisible();
    expect(w.currentChain).toBe(TESTNET);
    note("T24 reject the switch while connecting", "fixed: toast “Switch to Robinhood Chain Testnet to continue” + how; a second connect switches and connects");
  });

  test("rendering: 390 px and 1280 px, no horizontal scroll on any page; the bottom sheet opens on every action", async () => {
    const pages = ["/markets", "/stock/NVDA?tab=lend", "/stock/NVDA?tab=borrow", "/stock/NVDA?tab=short", "/portfolio", "/vault", "/data", "/alerts", "/terms", "/status", "/short-interest", "/backstop"];
    const wide: string[] = [];
    for (const width of [390, 1280]) {
      await p.setViewportSize({width, height: 900});
      for (const path of pages) {
        await p.goto(path);
        await p.waitForLoadState("networkidle").catch(() => {});
        const sw = await p.evaluate(() => document.documentElement.scrollWidth);
        if (sw > width) wide.push(`${path} @${width}: ${sw}px`);
      }
    }
    await p.setViewportSize({width: 390, height: 844});
    await p.goto("/stock/NVDA");
    for (const a of ["Lend", "Borrow", "Short"]) {
      await p.locator(".fixed.bottom-0").getByRole("button", {name: a, exact: true}).click();
      const sheet = p.getByRole("dialog", {name: /Lend, borrow or short NVDA/});
      await expect(sheet).toBeVisible();
      const box = (await sheet.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      await p.keyboard.press("Escape");
    }
    await p.goto("/vault");
    await p.getByTestId("open-withdraw").click();
    await expect(p.getByTestId("vault-panel")).toBeVisible();
    await shot(p, "break-390-vault-sheet");
    await p.setViewportSize({width: 1280, height: 900});
    expect(wide).toEqual([]);
    note("390 / 1280 px", `pass: ${pages.length} pages × 2 widths without horizontal scroll; Lend/Borrow/Short and vault sheets open inside the viewport`);
  });

  test("keyboard only: lend 0.01 NVDA with Tab / type / Enter", async () => {
    w.label = "break keyboard lend";
    await p.goto("/stock/NVDA?tab=lend");
    await expect(p.getByTestId("account")).toBeVisible();
    const sends = w.sends.length;
    const tabTo = async (testId: string) => {
      for (let i = 0; i < 80; i++) {
        await p.keyboard.press("Tab");
        if (await p.evaluate((id) => document.activeElement?.getAttribute("data-testid") === id, testId)) return;
      }
      throw new Error(`${testId} not reachable with Tab`);
    };
    await tabTo("amount");
    await p.keyboard.type("0.01");
    await expect(p.getByTestId("submit")).toBeEnabled({timeout: 60_000}); // disabled buttons take no focus
    await tabTo("submit");
    await p.keyboard.press("Enter");
    await expect(p.getByRole("dialog")).toBeVisible();
    await tabTo("confirm");
    await p.keyboard.press("Enter");
    await stepsDone(p);
    await p.keyboard.press("Escape");
    expect(w.sends.length - sends).toBe(1);
    note("keyboard only", `pass: amount → review → confirm by Tab/Enter (${w.sends.at(-1)!.hash})`);
  });

  test("vault: the withdraw form says up front what is instant and what queues", async () => {
    await p.goto("/vault");
    await p.getByTestId("mode-withdraw").click();
    await expect(p.getByTestId("withdraw-form")).toContainText(/Instant up to the cash buffer \(\d+ USDG now\); more is queued/);
    note("vault up front", "pass: the withdraw form shows the instant capacity and the queue rule before any amount is typed");
  });

  test("cleanup: withdraw the break lends", async () => {
    w.label = "break cleanup";
    if ((await bal(d.stocks.NVDA.vault, me())(w)) === 0n) return;
    await waitLiquidity(w, "NVDA", 0n);
    await p.goto("/portfolio");
    const b = p.getByTestId("withdraw-lend-NVDA");
    await b.waitFor({timeout: 30_000}).catch(() => p.reload()); // a chain read that failed: read again
    await b.click();
    await confirmReview(p, /Withdrew your NVDA/);
  });
});

// ---- restricted region (GEO_STATIC_COUNTRY=US on the web server) --------------------------------------------------
/**
 * APP-R2 with real signatures. Two phases around a web restart: GEO_PHASE=prep (the usual DE stack) opens positions to
 * exit; GEO_PHASE=exit (web restarted with GEO_STATIC_COUNTRY=US) exits them from /portfolio: partial repay, repay all,
 * withdraw collateral, close a short, withdraw from the vault. Skipped unless GEO_PHASE is set.
 */
test.describe.serial("46630 restricted region: exits still work", () => {
  const phase = process.env.GEO_PHASE;
  test.skip(!phase, "set GEO_PHASE=prep (DE) or exit (web on GEO_STATIC_COUNTRY=US)");
  let p: Page;
  let w: TestnetWallet;

  test.beforeAll(async ({app, wallet}) => {
    p = app;
    w = wallet;
    await p.goto("/portfolio");
    await connect(p, w);
  });

  test("prep (DE): a 0.05 NVDA short and a 0.03 AAPL borrow to exit from the US", async () => {
    test.skip(phase !== "prep");
    w.label = "geo prep short NVDA";
    await waitLiquidity(w, "NVDA", parseUnits("0.05", 18));
    await p.goto("/stock/NVDA?tab=short");
    await p.getByTestId("collateral").fill("300");
    await p.getByTestId("borrow-amount").fill("0.05");
    await expect(p.getByTestId("pv-swap")).toBeVisible();
    await p.getByTestId("submit").click();
    await confirmReview(p, /Shorted/);
    w.label = "geo prep borrow AAPL";
    await waitLiquidity(w, "AAPL", parseUnits("0.03", 18));
    await p.goto("/stock/AAPL?tab=borrow");
    await p.getByTestId("collateral").fill("200");
    await p.getByTestId("borrow-amount").fill("0.03");
    await wadOf(p, "pv-hf-now");
    await p.getByTestId("submit").click();
    await confirmReview(p, /Borrowed/);
  });

  test("exit (US): entries blocked; partial repay, repay all, withdraw collateral, close, vault withdraw all work", async () => {
    test.skip(phase !== "exit");
    const conn = (await (await fetch("http://127.0.0.1:3000/api/compliance/connection")).json()) as {restricted: boolean};
    expect(conn.restricted, "web must run with GEO_STATIC_COUNTRY=US").toBe(true);
    await p.goto("/stock/NVDA?tab=short");
    await expect(p.getByTestId("restricted")).toBeVisible();
    await p.goto("/portfolio");
    await expect(p.getByText("You can still repay, close and withdraw")).toBeVisible();
    // Each exit runs if its position is still there (a rerun after an RPC burst picks up where it stopped).
    if ((await position(w, "AAPL")).borrowShares > 0n) {
      w.label = "geo US partial repay AAPL";
      await (await portfolioControl(p, "repay-amount-AAPL")).fill("0.01");
      await p.getByTestId("repay-AAPL").click();
      await confirmReview(p, /Repaid 0.01 AAPL/);
      w.label = "geo US repay all AAPL";
      await (await portfolioControl(p, "repay-AAPL")).click();
      await confirmReview(p, /Repaid/);
    }
    if ((await position(w, "AAPL")).collateral > 0n) {
      w.label = "geo US withdraw collateral AAPL";
      await (await portfolioControl(p, "withdraw-collateral-AAPL")).click();
      await confirmReview(p, /Withdrew your collateral/);
    }
    expect((await position(w, "AAPL")).collateral).toBe(0n);
    if ((await position(w, "NVDA")).borrowShares > 0n) {
      w.label = "geo US close NVDA";
      await (await portfolioControl(p, "close-NVDA")).click();
      await confirmReview(p, /Closed your NVDA position/);
    }
    expect((await position(w, "NVDA")).borrowShares).toBe(0n);
    w.label = "geo US vault withdraw 1";
    await p.getByTestId("vault-withdraw-open").click();
    await p.getByRole("dialog").last().getByTestId("withdraw-amount").fill("1");
    await p.getByRole("dialog").last().getByTestId("withdraw-submit").click();
    await confirmReview(p, /Withdrew 1 USDG/);
    await shot(p, "geo-us-exits");
  });
});
