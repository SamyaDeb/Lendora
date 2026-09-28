/**
 * The whole product on one machine for checking the UI against live data: anvil with a fresh DeployLocal and a
 * seeded week, the indexer, the API, compliance and alerts (the e2e harness, isolated ports), plus the web app on
 * :3002 (or WEB_PORT) with the e2e mock wallet (anvil account #7, funded). `WEB_MODE=start` builds and runs
 * `next start` instead of `next dev` (Next allows one dev server per directory).
 *
 *   pnpm --filter @stockline/web exec tsx scripts/liveStack.ts
 *
 * Writes the URLs to .live-stack.json next to this file. Ctrl-C stops everything.
 */
import {spawn} from "node:child_process";
import {writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {startWebStack, WEB_DIR} from "../e2e/stack";

const port = Number(process.env.WEB_PORT ?? 3002);
let env = {} as NodeJS.ProcessEnv;
const w = await startWebStack({web: false, onEnv: (e) => (env = {...e, NEXT_DIST_DIR: ".next-live"})});
const info = {web: `http://127.0.0.1:${port}`, rpc: w.stack.anvil.url, api: w.stack.api.url, compliance: w.compliance.url};
writeFileSync(fileURLToPath(new URL("./.live-stack.json", import.meta.url)), JSON.stringify(info, null, 2));
console.log("[live] services up", info);
// A block every 3 s, like a live chain: the app's deadlines are "latest block + 30 min", which an idle anvil (one
// block per transaction, clock running) would leave in the past.
const miner = setInterval(() => void fetch(info.rpc, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "evm_mine", params: []})}).catch(() => {}), 3000);
const start = process.env.WEB_MODE === "start";
const build = () => new Promise<number | null>((resolve) => spawn("npx", ["next", "build"], {cwd: WEB_DIR, env, stdio: "inherit"}).on("exit", resolve));
const run = () => spawn("npx", ["next", start ? "start" : "dev", "-p", String(port), "-H", "127.0.0.1"], {cwd: WEB_DIR, env, stdio: "inherit"});
if (start && (await build()) !== 0) throw new Error("next build failed");
let web = run();
console.log(`[live] web on ${info.web} (pid ${process.pid}; \`kill -USR2 ${process.pid}\` rebuilds and restarts the web app)`);
process.on("SIGUSR2", async () => {
  if (!start) return;
  console.log("[live] rebuilding");
  if ((await build()) !== 0) return console.log("[live] build failed; the running app is unchanged");
  web.kill();
  web = run();
  console.log("[live] restarted");
});

const stop = async () => {
  clearInterval(miner);
  web.kill();
  await w.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
