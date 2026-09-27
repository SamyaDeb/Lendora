import {EventEmitter} from "node:events";
import type {IncomingMessage} from "node:http";
import type {Duplex} from "node:stream";
import {randomBytes} from "node:crypto";
import type {Redis} from "ioredis";
import {WebSocketServer, WebSocket} from "ws";
import type {ChainDeployment} from "@stockline/sdk";
import type {IndexerDb, EventCursor} from "./db.js";
import {envelope, eventView, marketView} from "./model.js";
import {clientKey, type Limiter} from "./limits.js";
import type {ApiKeys} from "./keys.js";

/**
 * `WS /v1/stream` (07 §2, SI-R11): clients send `{"channel":"market","symbol":"NVDA"}` or
 * `{"channel":"events","symbol":"*"}` (optional `"op":"unsubscribe"`). One publisher (elected through Redis when
 * several API instances run) polls the indexer every `pollMs` and fans updates out through Redis pub/sub; every
 * instance pushes to its own subscribers. Pushes land within ~pollMs + indexer lag of the block.
 */
export interface Fanout {
  publish(msg: StreamMessage): Promise<void>;
  onMessage(handler: (msg: StreamMessage) => void): void;
  /** True if this instance should run the publisher now. */
  isLeader(): Promise<boolean>;
  close(): Promise<void>;
}

export interface StreamMessage {
  channel: "market" | "events";
  symbol: string;
  asOfBlock: string;
  asOfTime: string;
  confirmed: boolean;
  data: unknown;
}

export class MemoryFanout implements Fanout {
  private readonly e = new EventEmitter();
  async publish(msg: StreamMessage) {
    this.e.emit("m", msg);
  }
  onMessage(h: (m: StreamMessage) => void) {
    this.e.on("m", h);
  }
  async isLeader() {
    return true;
  }
  async close() {
    this.e.removeAllListeners();
  }
}

export class RedisFanout implements Fanout {
  private readonly id = randomBytes(8).toString("hex");
  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis,
    private readonly channel = "stockline:stream",
    private readonly lockKey = "stockline:stream:leader",
  ) {}
  async publish(msg: StreamMessage) {
    await this.pub.publish(this.channel, JSON.stringify(msg));
  }
  onMessage(h: (m: StreamMessage) => void) {
    this.sub.subscribe(this.channel).catch((e) => console.error(`[stream] subscribe: ${String(e)}`));
    this.sub.on("message", (_c, raw: string) => h(JSON.parse(raw) as StreamMessage));
  }
  /** Leader lease: 5 s, renewed by the holder on every poll. */
  async isLeader() {
    const got = await this.pub.set(this.lockKey, this.id, "PX", 5000, "NX");
    if (got === "OK") return true;
    if ((await this.pub.get(this.lockKey)) === this.id) {
      await this.pub.pexpire(this.lockKey, 5000);
      return true;
    }
    return false;
  }
  async close() {
    await this.sub.quit();
    await this.pub.quit();
  }
}

/** Polls the indexer and publishes changed market snapshots and new events. */
export class StreamPublisher {
  private lastBlock = new Map<string, string>();
  private cursor?: EventCursor;
  private timer?: NodeJS.Timeout;
  private running = false;
  private inFlight?: Promise<void>;

  constructor(
    private readonly db: IndexerDb,
    private readonly fanout: Fanout,
    private readonly d: ChainDeployment,
    private readonly pollMs: number,
  ) {}

  start() {
    const loop = async () => {
      if (this.running) return;
      this.running = true;
      try {
        if (await this.fanout.isLeader()) await this.poll();
      } catch (e) {
        console.error(`[stream] ${String(e)}`);
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => {
      this.inFlight = loop();
    }, this.pollMs);
  }

  /** Stops polling and waits for a poll in flight, so the caller can close Redis and Postgres after it. */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  async poll(): Promise<void> {
    const head = await this.db.head();
    for (const row of await this.db.latestSnapshots()) {
      const t = String(row.ticker);
      const b = String(row.block_number);
      if (this.lastBlock.get(t) === b) continue;
      this.lastBlock.set(t, b);
      const env = envelope(head, BigInt(b), BigInt(String(row.timestamp)));
      await this.fanout.publish({channel: "market", symbol: t, asOfBlock: env.asOfBlock, asOfTime: env.asOfTime, confirmed: env.confirmed, data: marketView(row, this.d)});
    }
    if (!this.cursor) {
      this.cursor = await this.db.lastEventCursor(); // only new events are streamed
      return;
    }
    for (const e of await this.db.eventsAfter(this.cursor)) {
      this.cursor = {block: BigInt(String(e.block_number)), logIndex: Number(e.log_index)};
      const env = envelope(head, BigInt(String(e.block_number)), BigInt(String(e.timestamp)));
      await this.fanout.publish({channel: "events", symbol: String(e.ticker), asOfBlock: env.asOfBlock, asOfTime: env.asOfTime, confirmed: env.confirmed, data: eventView(e)});
    }
  }
}

interface Sub {
  channel: "market" | "events";
  symbol: string;
}

/** Attach `/v1/stream` to an HTTP server (upgrade handler). */
export class StreamServer {
  private readonly wss = new WebSocketServer({noServer: true, maxPayload: 4096});
  private readonly subs = new Map<WebSocket, Sub[]>();

  constructor(
    private readonly deps: {
      db: IndexerDb;
      fanout: Fanout;
      limiter: Limiter;
      keys: ApiKeys;
      d: ChainDeployment;
      freeWs: number;
      keyedWs: number;
      clientIp: (req: IncomingMessage) => string;
    },
  ) {
    deps.fanout.onMessage((m) => this.dispatch(m));
    const ping = setInterval(() => {
      for (const ws of this.wss.clients) if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30_000);
    ping.unref();
  }

  get connections(): number {
    return this.wss.clients.size;
  }

  private dispatch(m: StreamMessage) {
    const raw = JSON.stringify(m);
    for (const [ws, subs] of this.subs) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (subs.some((s) => s.channel === m.channel && (s.symbol === "*" || s.symbol === m.symbol))) ws.send(raw);
    }
  }

  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const key = (req.headers["x-api-key"] as string | undefined) ?? url.searchParams.get("apiKey") ?? undefined;
    let slot: string;
    let max: number;
    if (key) {
      const k = await this.deps.keys.resolve(key);
      if (!k) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      slot = `key:${k.id}`;
      max = this.deps.keyedWs;
    } else {
      slot = clientKey(this.deps.clientIp(req));
      max = this.deps.freeWs;
    }
    if (!(await this.deps.limiter.acquire(slot, max))) {
      socket.end(`HTTP/1.1 429 Too Many Requests\r\ncontent-type: application/json\r\n\r\n{"error":"at most ${max} WebSocket connection(s) for this tier (SI-R10)"}`);
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.subs.set(ws, []);
      ws.on("close", () => {
        this.subs.delete(ws);
        // Also runs while the server shuts down and Redis may already be closed; the slot key expires by itself.
        this.deps.limiter.release(slot).catch(() => {});
      });
      ws.on("message", (raw) => this.onClientMessage(ws, raw.toString()).catch((e) => console.error(`[stream] message: ${String(e)}`)));
      ws.send(JSON.stringify({type: "welcome", channels: ["market", "events"], symbols: [...Object.keys(this.deps.d.stocks), "*"]}));
    });
  }

  private async onClientMessage(ws: WebSocket, raw: string) {
    let msg: {op?: string; channel?: string; symbol?: string};
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({type: "error", error: "invalid JSON"}));
      return;
    }
    const symbol = (msg.symbol ?? "*").toUpperCase();
    if ((msg.channel !== "market" && msg.channel !== "events") || (symbol !== "*" && !this.deps.d.stocks[symbol])) {
      ws.send(JSON.stringify({type: "error", error: 'expected {"channel":"market"|"events","symbol":"<SYMBOL>"|"*"}'}));
      return;
    }
    const subs = this.subs.get(ws) ?? [];
    const channel = msg.channel;
    if (msg.op === "unsubscribe") {
      this.subs.set(ws, subs.filter((s) => !(s.channel === channel && s.symbol === symbol)));
      ws.send(JSON.stringify({type: "unsubscribed", channel, symbol}));
      return;
    }
    if (!subs.some((s) => s.channel === channel && s.symbol === symbol)) subs.push({channel, symbol});
    this.subs.set(ws, subs);
    ws.send(JSON.stringify({type: "subscribed", channel, symbol}));
    if (channel === "market") {
      // Current state right away, then updates.
      const head = await this.deps.db.head();
      const rows = symbol === "*" ? await this.deps.db.latestSnapshots() : [await this.deps.db.latestSnapshot(symbol)].filter((r) => r !== undefined);
      for (const row of rows) {
        const env = envelope(head, BigInt(String(row.block_number)), BigInt(String(row.timestamp)));
        ws.send(JSON.stringify({channel: "market", symbol: row.ticker, asOfBlock: env.asOfBlock, asOfTime: env.asOfTime, confirmed: env.confirmed, data: marketView(row, this.deps.d)}));
      }
    }
  }

  close() {
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }
}
