/**
 * SI-R5 daily reconciliation (schedule it daily, e.g. a Railway cron: `pnpm --filter @lendora/indexer reconcile`).
 *
 *   DATABASE_URL=… RPC_URL=… LENDORA_NETWORK=46630 [INDEXER_SCHEMA=lendora] [PAGER_WEBHOOK_URL=…] pnpm reconcile
 *
 * Exit code 0 when indexed totals equal onchain reads at the indexed head, 2 when it paged.
 */
import pg from "pg";
import {createPublicClient, http} from "viem";
import {networkConfig} from "../lib/network.js";
import {ConsolePager, reconcile, WebhookPager} from "../lib/reconcile.js";

const n = networkConfig();
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
const client = createPublicClient({transport: http(n.rpcUrl)});
const pager = process.env.PAGER_WEBHOOK_URL ? new WebhookPager(process.env.PAGER_WEBHOOK_URL) : new ConsolePager();
const r = await reconcile({pool, schema: process.env.INDEXER_SCHEMA ?? "lendora", client, d: n.d, pager});
console.log(`reconciled ${r.checked} values at block ${r.block}: ${r.diffs.length} diff(s)`);
await pool.end();
process.exit(r.diffs.length ? 2 : 0);
