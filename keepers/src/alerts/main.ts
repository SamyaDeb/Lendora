import {serve} from "@hono/node-server";
import pg from "pg";
import {loadConfig} from "../common/config.js";
import {publicClient} from "../common/chain.js";
import {Health} from "../common/health.js";
import {runLoop} from "../common/loop.js";
import {alertsApp} from "./server.js";
import {SettingsStore} from "./settings.js";
import {transportsFromEnv} from "./transports.js";
import {AlertWatcher, IndexerPositions} from "./watcher.js";

/** `pnpm --filter @stockline/keepers alerts` (APP-R8). Env: see README (DRY_RUN is the default). */
const cfg = loadConfig();
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 5});
const store = new SettingsStore(pool, process.env.ALERTS_SCHEMA ?? "stockline_alerts");
await store.migrate();
const client = publicClient(cfg.rpcUrl, cfg.deploymentKey, cfg.archiveRpcUrl);
const health = new Health(cfg.maxStaleMs);
const watcher = new AlertWatcher(client, cfg.deployment, store, new IndexerPositions(pool, process.env.INDEXER_SCHEMA ?? "stockline"), transportsFromEnv(), {dryRun: cfg.dryRun, health});
const app = alertsApp(store, client, health, {allowHttpWebhooks: cfg.deploymentKey === 31337});
serve({fetch: app.fetch, port: Number(process.env.PORT ?? 42072), hostname: process.env.HOST ?? "0.0.0.0"});
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
console.log(`[alerts] ${cfg.dryRun ? "DRY RUN" : "LIVE"} on ${String(cfg.deploymentKey)}, every ${process.env.ALERTS_INTERVAL_MS ?? 5000} ms`);
await runLoop(() => watcher.tick().then(() => undefined), Number(process.env.ALERTS_INTERVAL_MS ?? 5000), abort.signal);
await pool.end();
