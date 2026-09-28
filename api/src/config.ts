import {getDeployment, parseDeploymentKey, type ChainDeployment, type DeploymentKey} from "@stockline/sdk";

/** API configuration from the environment. Secrets (database/redis URLs with passwords) come only from env. */
export interface ApiConfig {
  port: number;
  host: string;
  databaseUrl: string;
  /** Schema of the indexer's tables or views (`ponder start --views-schema`), e.g. "stockline". */
  indexerSchema: string;
  /** Schema the API owns for API keys. */
  apiSchema: string;
  /** Unset = in-memory rate limits and fan-out (single instance, tests). */
  redisUrl?: string;
  rpcUrl: string;
  key: DeploymentKey;
  chainId: number;
  d: ChainDeployment;
  /** SI-R10 tiers. */
  freeRpm: number;
  keyedRpm: number;
  freeWs: number;
  keyedWs: number;
  maxKeysPerAddress: number;
  /** Use the first `X-Forwarded-For` hop as the client IP (behind the Railway/edge proxy). */
  trustProxy: boolean;
  /** OFF-7: proxies in front of the API that append to `X-Forwarded-For` (Railway edge = 1). */
  trustedProxyHops: number;
  /** SIWE domain and URI the API accepts in sign-in messages. */
  siweDomain: string;
  /** WS fan-out poll interval (SI-R11: pushes within 2 s of the block). */
  streamPollMs: number;
}

/** OFF-5: a numeric env var with bounds; a bad value fails startup with the variable's name (before: `NaN`). */
function num(env: NodeJS.ProcessEnv, name: string, dflt: number, min: number, max: number): number {
  const v = env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max} (got "${v}")`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const raw = env.STOCKLINE_NETWORK ?? env.DEPLOYMENT_KEY ?? "31337";
  if (raw === "4663") throw new Error("Phase 2 serves no real 4663 deployment");
  const key = parseDeploymentKey(raw);
  const d = getDeployment(key);
  if (!d) throw new Error(`no deployment "${raw}" in @stockline/sdk addresses.json`);
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (env.TRUST_PROXY !== undefined && !["true", "false", ""].includes(env.TRUST_PROXY)) throw new Error('TRUST_PROXY must be "true" or "false"');
  return {
    port: num(env, "PORT", 42070, 0, 65_535),
    host: env.HOST ?? "0.0.0.0",
    databaseUrl: env.DATABASE_URL,
    indexerSchema: env.INDEXER_SCHEMA ?? "stockline",
    apiSchema: env.API_SCHEMA ?? "stockline_api",
    redisUrl: env.REDIS_URL || undefined,
    rpcUrl: env.RPC_URL ?? "http://127.0.0.1:8545",
    key,
    chainId: key === "fork-4663" ? 4663 : Number(key),
    d,
    freeRpm: num(env, "FREE_RPM", 60, 1, 100_000),
    keyedRpm: num(env, "KEYED_RPM", 600, 1, 1_000_000),
    freeWs: num(env, "FREE_WS", 1, 0, 1_000),
    keyedWs: num(env, "KEYED_WS", 10, 0, 10_000),
    maxKeysPerAddress: num(env, "MAX_KEYS_PER_ADDRESS", 5, 1, 1_000),
    trustProxy: env.TRUST_PROXY === "true",
    trustedProxyHops: num(env, "TRUSTED_PROXY_HOPS", 1, 1, 10),
    siweDomain: env.SIWE_DOMAIN ?? "localhost",
    streamPollMs: num(env, "STREAM_POLL_MS", 200, 50, 60_000),
  };
}
