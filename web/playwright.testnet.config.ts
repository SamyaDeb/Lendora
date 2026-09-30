import {defineConfig, devices} from "@playwright/test";

/**
 * The signed browser pass on Robinhood Chain testnet (46630) against the local testnet stack
 * (`scripts/dev-testnet.sh --network 46630`, web on http://127.0.0.1:3000). Real transactions: serial, one worker,
 * long timeouts. Refuses to run without TESTNET_GO=yes and SMOKE_KEY (the tester key, from the environment).
 */
if (process.env.TESTNET_GO !== "yes" || !process.env.SMOKE_KEY) {
  throw new Error("playwright.testnet.config.ts sends real transactions on 46630: set TESTNET_GO=yes and SMOKE_KEY.");
}

export default defineConfig({
  testDir: "e2e",
  testMatch: /(^|\/)testnet\.spec\.ts$/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 10 * 60_000,
  globalTimeout: 90 * 60_000,
  expect: {timeout: 60_000},
  outputDir: "e2e/.results-testnet",
  reporter: [["list"], ["html", {outputFolder: "e2e/.report-testnet", open: "never"}]],
  use: {baseURL: "http://127.0.0.1:3000", screenshot: "only-on-failure", trace: "retain-on-failure", actionTimeout: 60_000, navigationTimeout: 120_000},
  projects: [{name: "chromium", use: {...devices["Desktop Chrome"], viewport: {width: 1280, height: 900}}}],
});
