/**
 * Writes api/openapi.json (OpenAPI 3.1 generated from the route schemas) and regenerates the SDK's typed client
 * types: `pnpm --filter @stockline/api openapi`. CI checks both files are up to date.
 */
import {writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import {getDeployment} from "@stockline/sdk";
import {createApp, openApiInfo} from "../src/app.js";
import type {IndexerDb} from "../src/db.js";
import type {ApiKeys} from "../src/keys.js";
import type {ChainReader} from "../src/chain.js";
import {MemoryLimiter} from "../src/limits.js";

const d = getDeployment(31337)!;
const config = {chainId: 46630, key: 46630, d, freeRpm: 60, keyedRpm: 600, trustProxy: true, siweDomain: "api.stockline.xyz", freeWs: 1, keyedWs: 10} as const;
// The document depends only on the route schemas; no database or RPC is touched.
const app = createApp({db: {} as IndexerDb, limiter: new MemoryLimiter(), keys: {} as ApiKeys, chain: {} as ChainReader, config: {...config}});
const doc = app.getOpenAPI31Document(openApiInfo(config));
const out = fileURLToPath(new URL("../openapi.json", import.meta.url));
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${out} (${Object.keys(doc.paths ?? {}).length} paths)`);
const types = fileURLToPath(new URL("../../packages/sdk/src/api/schema.ts", import.meta.url));
execFileSync("npx", ["openapi-typescript", out, "-o", types], {stdio: "inherit"});
