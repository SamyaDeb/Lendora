import {loadConfig} from "./config.js";
import {startApi} from "./server.js";

/** `pnpm --filter @lendora/api start`. Environment: see README.md and .env.example. */
const config = loadConfig();
const api = await startApi(config);
console.log(`[api] ${String(config.key)} on ${api.url}/v1 (indexer schema "${config.indexerSchema}", ${config.redisUrl ? "redis" : "in-memory"} limits)`);
const stop = async () => {
  await api.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
