import {serve} from "@hono/node-server";
import pg from "pg";
import {reconcile} from "@stockline/indexer/reconcile";
import {loadConfig} from "../common/config.js";
import {publicClient} from "../common/chain.js";
import {Health} from "../common/health.js";
import {runLoop} from "../common/loop.js";
import {IndexerBorrowers, Monitor} from "./monitor.js";
import {pagersFromEnv} from "./pager.js";
import {monitorApp} from "./server.js";
import {MonitorStore} from "./store.js";

/**
 * `pnpm --filter @stockline/keepers monitor` (MON-R1…R14). Read-only: no signer, no dry run. Env (keepers/.env.example):
 * DATABASE_URL, INDEXER_SCHEMA, MONITOR_SCHEMA, MONITOR_INTERVAL_MS (default 2000), PORT (42073), MONITOR_KEEPERS
 * ("allocator=http://…/health,guard=…"), pagers (PAGERDUTY_ROUTING_KEY, OPSGENIE_API_KEY, MONITOR_TELEGRAM_*,
 * MONITOR_WEBHOOK_*), L2_GAP_SEC, RECONCILE_EVERY_MS (SI-R5 in-process; 0 disables), MONITOR_GAS_WATCH
 * ("operator=0x…", MON-R15), GAS_BURN_WEI_PER_DAY.
 */
const cfg = loadConfig();
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 5});
const store = new MonitorStore(pool, process.env.MONITOR_SCHEMA ?? "stockline_monitor");
await store.migrate();
const client = publicClient(cfg.rpcUrl, cfg.deploymentKey);
const health = new Health(cfg.maxStaleMs);
const pagers = pagersFromEnv();
const indexerSchema = process.env.INDEXER_SCHEMA ?? "stockline";
const parseList = (v: string | undefined): Record<string, string> =>
  Object.fromEntries(
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((kv) => kv.split("=") as [string, string]),
  );
const keepers = parseList(process.env.MONITOR_KEEPERS);
const reconcileEveryMs = Number(process.env.RECONCILE_EVERY_MS ?? 24 * 3600_000);
const monitor = new Monitor(
  client,
  cfg.deployment,
  store,
  pagers,
  new IndexerBorrowers(pool, indexerSchema),
  {
    keepers,
    l2GapSec: BigInt(process.env.L2_GAP_SEC ?? 300),
    gasWatch: parseList(process.env.MONITOR_GAS_WATCH) as Record<string, `0x${string}`>,
    gasBurnWeiPerDay: BigInt(process.env.GAS_BURN_WEI_PER_DAY ?? 0),
    reconcileEveryMs,
    // SI-R5 hooked into the pager: diffs become an INDEXER_LAG incident (MON-R14) instead of a separate page.
    reconcile:
      reconcileEveryMs > 0
        ? async () => {
            const r = await reconcile({pool, schema: indexerSchema, client, d: cfg.deployment, pager: {page: async () => {}}});
            return {block: r.block, diffs: r.diffs.length};
          }
        : undefined,
  },
  health,
);
serve({fetch: monitorApp(store, health, Object.keys(cfg.deployment.stocks), pagers).fetch, port: Number(process.env.PORT ?? 42073), hostname: process.env.HOST ?? "0.0.0.0"});
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
const every = Number(process.env.MONITOR_INTERVAL_MS ?? 2000);
console.log(`[monitor] read-only on ${String(cfg.deploymentKey)}, every ${every} ms, pagers: ${pagers.map((p) => p.name).join(", ")}`);
await runLoop(() => monitor.tick().then(() => undefined), every, abort.signal);
await pool.end();
