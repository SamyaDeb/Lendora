/**
 * 06 acceptance: Lighthouse performance ≥ 85 on `/` and `/short-interest`. Starts the local product (production
 * build against the anvil stack) and runs Lighthouse (default mobile profile with simulated throttling) in
 * Playwright's Chromium. Writes web/lighthouse/results.md (+ the JSON reports, gitignored).
 *
 *   pnpm --filter @stockline/web lighthouse
 */
import {writeFileSync} from "node:fs";
import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import {chromium} from "@playwright/test";
import {startWebStack} from "../e2e/stack";

const PAGES = ["/", "/short-interest"];
const w = await startWebStack();
const chrome = await chromeLauncher.launch({chromePath: chromium.executablePath(), chromeFlags: ["--headless=new", "--no-sandbox"]});
const rows: string[] = [];
let ok = true;
try {
  for (const path of PAGES) {
    // Warm the server (first render compiles nothing in production, but primes the API cache like a live site).
    await fetch(`${w.baseUrl}${path}`);
    const r = await lighthouse(`${w.baseUrl}${path}`, {port: chrome.port, output: "json", logLevel: "error", onlyCategories: ["performance", "accessibility", "best-practices"]});
    const lhr = r!.lhr;
    const score = (k: string) => Math.round((lhr.categories[k]?.score ?? 0) * 100);
    const perf = score("performance");
    ok &&= perf >= 85;
    const a = lhr.audits;
    rows.push(`| \`${path}\` | **${perf}** | ${score("accessibility")} | ${score("best-practices")} | ${a["first-contentful-paint"]?.displayValue} | ${a["largest-contentful-paint"]?.displayValue} | ${a["total-blocking-time"]?.displayValue} | ${a["cumulative-layout-shift"]?.displayValue} |`);
    writeFileSync(new URL(`../lighthouse/${path === "/" ? "markets" : path.slice(1)}.json`, import.meta.url), JSON.stringify(lhr, null, 1));
    console.log(`[lighthouse] ${path}: performance ${perf}, accessibility ${score("accessibility")}`);
  }
} finally {
  chrome.kill();
  await w.close();
}
const md = `# Lighthouse (06 acceptance: performance ≥ 85)

Run: \`pnpm --filter @stockline/web lighthouse\` on ${new Date().toISOString()}: production build (\`next build && next start\`) against the local
stack (anvil seed week → indexer → API), Lighthouse ${"13"} default mobile profile (simulated slow 4G, 4× CPU), Chromium from Playwright.

| Page | Performance | Accessibility | Best practices | FCP | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}
`;
writeFileSync(new URL("../lighthouse/results.md", import.meta.url), md);
console.log(md);
process.exit(ok ? 0 : 1);
