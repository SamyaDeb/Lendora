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
  /** SIWE domain and URI the API accepts in sign-in messages. */
  siweDomain: string;
  /** WS fan-out poll interval (SI-R11: pushes within 2 s of the block). */
  streamPollMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const raw = env.STOCKLINE_NETWORK ?? env.DEPLOYMENT_KEY ?? "31337";
  if (raw === "4663") throw new Error("Phase 2 serves no real 4663 deployment");
  const key = parseDeploymentKey(raw);
  const d = getDeployment(key);
  if (!d) throw new Error(`no deployment "${raw}" in @stockline/sdk addresses.json`);
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return {
    port: Number(env.PORT ?? 42070),
    host: env.HOST ?? "0.0.0.0",
    databaseUrl: env.DATABASE_URL,
    indexerSchema: env.INDEXER_SCHEMA ?? "stockline",
    apiSchema: env.API_SCHEMA ?? "stockline_api",
    redisUrl: env.REDIS_URL || undefined,
    rpcUrl: env.RPC_URL ?? "http://127.0.0.1:8545",
    key,
    chainId: key === "fork-4663" ? 4663 : Number(key),
    d,
    freeRpm: Number(env.FREE_RPM ?? 60),
    keyedRpm: Number(env.KEYED_RPM ?? 600),
    freeWs: Number(env.FREE_WS ?? 1),
    keyedWs: Number(env.KEYED_WS ?? 10),
    maxKeysPerAddress: Number(env.MAX_KEYS_PER_ADDRESS ?? 5),
    trustProxy: env.TRUST_PROXY === "true",
    siweDomain: env.SIWE_DOMAIN ?? "localhost",
    streamPollMs: Number(env.STREAM_POLL_MS ?? 200),
  };
}
