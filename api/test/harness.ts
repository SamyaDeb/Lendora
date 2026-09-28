import {ChainDriver, seedWeek, startAnvil, startPostgres, startRedis, type Anvil, type SeedResult, type Service} from "@stockline/devnet";
import {startIndexer, type IndexerHandle} from "@stockline/indexer/harness";
import {getDeployment} from "@stockline/sdk";
import type {ApiConfig} from "../src/config.js";
import {startApi, type RunningApi} from "../src/server.js";

/**
 * The whole offchain stack for tests: anvil (DeployLocal fixture) + the devnet seed week + Postgres + the Ponder
 * indexer + the API (in-memory limits by default, Redis on request). Reused by the web e2e and alerts tests.
 */
export interface Stack {
  anvil: Anvil;
  drv: ChainDriver;
  seed?: SeedResult;
  pg: Service;
  redis?: Service;
  indexer: IndexerHandle;
  api: RunningApi;
  config: ApiConfig;
  /** Another API instance on the same database (and Redis, if any). */
  startApi(overrides?: Partial<ApiConfig>): Promise<RunningApi>;
  /** Wait until the indexer has processed the chain head. */
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface StackOptions {
  seed?: boolean;
  redis?: boolean;
  api?: Partial<ApiConfig>;
}

export async function startStack(o: StackOptions = {}): Promise<Stack> {
  const anvil = await startAnvil();
  const drv = new ChainDriver(anvil);
  const seed = o.seed === false ? undefined : await seedWeek(drv);
  if (o.seed === false) await drv.useAttestationSigner();
  const pg = await startPostgres();
  const redis = o.redis ? await startRedis() : undefined;
  const indexer = await startIndexer({rpcUrl: anvil.url, databaseUrl: pg.url});
  await indexer.waitForBlock(await anvil.client.getBlockNumber());
  const d = getDeployment(31337)!;
  const config: ApiConfig = {
    port: 0,
    host: "127.0.0.1",
    databaseUrl: pg.url,
    indexerSchema: indexer.viewsSchema,
    apiSchema: `${indexer.viewsSchema}_api`,
    redisUrl: redis?.url,
    rpcUrl: anvil.url,
    key: 31337,
    chainId: 31337,
    d,
    freeRpm: 1000,
    keyedRpm: 10_000,
    freeWs: 1,
    keyedWs: 10,
    maxKeysPerAddress: 5,
    trustProxy: true,
    trustedProxyHops: 1,
    siweDomain: "localhost",
    streamPollMs: 100,
    ...o.api,
  };
  const api = await startApi(config);
  const extra: RunningApi[] = [];
  return {
    anvil,
    drv,
    seed,
    pg,
    redis,
    indexer,
    api,
    config,
    async startApi(overrides = {}) {
      const a = await startApi({...config, ...overrides});
      extra.push(a);
      return a;
    },
    async sync() {
      await indexer.waitForBlock(await anvil.client.getBlockNumber());
    },
    async close() {
      for (const a of extra) await a.close().catch(() => {});
      await api.close().catch(() => {});
      await indexer.stop();
      redis?.stop();
      pg.stop();
      anvil.stop();
    },
  };
}
