import type {AddressInfo} from "node:net";
import type {IncomingMessage, Server} from "node:http";
import {serve} from "@hono/node-server";
import {Redis} from "ioredis";
import {createApp} from "./app.js";
import type {ApiConfig} from "./config.js";
import {IndexerDb} from "./db.js";
import {ApiKeys, MemoryNonceStore, RedisNonceStore} from "./keys.js";
import {ipFromForwardedFor, MemoryLimiter, RedisLimiter, type Limiter} from "./limits.js";
import {RpcChainReader} from "./chain.js";
import {MemoryFanout, RedisFanout, StreamPublisher, StreamServer, type Fanout} from "./stream.js";

export interface RunningApi {
  url: string;
  port: number;
  db: IndexerDb;
  stream: StreamServer;
  close(): Promise<void>;
}

/** HTTP + `WS /v1/stream` on one port. Redis when `redisUrl` is set (rate limits, nonces, fan-out, leader election),
 * in-memory otherwise (single instance). */
export async function startApi(config: ApiConfig): Promise<RunningApi> {
  const db = new IndexerDb(config.databaseUrl, config.indexerSchema, config.apiSchema);
  await db.migrate();
  const chain = new RpcChainReader(config.rpcUrl, config.d);
  let limiter: Limiter;
  let fanout: Fanout;
  let redis: Redis | undefined;
  let nonces;
  if (config.redisUrl) {
    // Every client gets an error listener: a Redis outage degrades limits and fan-out, it must not crash the API.
    const mk = () => new Redis(config.redisUrl!, {maxRetriesPerRequest: 2}).on("error", (e) => console.error(`[api] redis: ${e.message}`));
    redis = mk();
    limiter = new RedisLimiter(redis);
    fanout = new RedisFanout(mk(), mk());
    nonces = new RedisNonceStore(redis);
  } else {
    limiter = new MemoryLimiter();
    fanout = new MemoryFanout();
    nonces = new MemoryNonceStore();
  }
  const keys = new ApiKeys(db, nonces, chain.client, {domain: config.siweDomain, chainId: config.chainId, maxPerAddress: config.maxKeysPerAddress});
  const app = createApp({db, limiter, keys, chain, config});

  const clientIp = (req: IncomingMessage) => {
    if (config.trustProxy) {
      const xff = req.headers["x-forwarded-for"];
      const ip = ipFromForwardedFor(Array.isArray(xff) ? xff.join(",") : xff, config.trustedProxyHops); // OFF-7
      if (ip) return ip;
    }
    return req.socket.remoteAddress ?? "unknown";
  };
  const stream = new StreamServer({db, fanout, limiter, keys, d: config.d, freeWs: config.freeWs, keyedWs: config.keyedWs, freeRpm: config.freeRpm, clientIp});
  const publisher = new StreamPublisher(db, fanout, config.d, config.streamPollMs);
  publisher.start();

  const server = (await new Promise<Server>((resolve) => {
    const s = serve({fetch: app.fetch, port: config.port, hostname: config.host}, () => resolve(s as Server));
  })) as Server;
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path !== "/v1/stream") {
      socket.destroy();
      return;
    }
    void stream.handleUpgrade(req, socket, head).catch(() => socket.destroy());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    db,
    stream,
    async close() {
      await publisher.stop();
      stream.close();
      await new Promise<void>((r) => server.close(() => r()));
      await fanout.close();
      if (redis) await redis.quit();
      await db.close();
    },
  };
}
