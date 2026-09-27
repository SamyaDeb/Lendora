import {defineConfig, devices} from "@playwright/test";

/** 06 e2e on anvil: every router flow of 05 §4 through the UI, preview vs onchain within 0.1%, APP-R2/R4 states. */
export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  // The whole run, global setup included (stack + next build): fail with logs rather than hang in CI.
  globalTimeout: 20 * 60_000,
  expect: {timeout: 30_000},
  outputDir: "e2e/.results",
  reporter: [["list"], ["html", {outputFolder: "e2e/.report", open: "never"}]],
  use: {baseURL: process.env.E2E_BASE_URL, trace: "retain-on-failure", viewport: {width: 1280, height: 900}},
  projects: [{name: "chromium", use: {...devices["Desktop Chrome"]}}],
});
