import {OpenAPIHono, createRoute, z} from "@hono/zod-openapi";
import {cors} from "hono/cors";
import type {Context} from "hono";
import type {HttpBindings} from "@hono/node-server";
import {formatUnits} from "viem";
import {HF_MIN_OPEN_WAD, U_MAX_WAD, nextClosure, nextEvent, safeErrorLine} from "@stockline/sdk";
import type {ApiConfig} from "./config.js";
import type {IndexerDb, EventCursor} from "./db.js";
import type {Limiter} from "./limits.js";
import {clientKey, ipFromForwardedFor} from "./limits.js";
import type {ApiKeys} from "./keys.js";
import {HttpError} from "./errors.js";
import type {ChainReader} from "./chain.js";
import {envelope, eventView, historyView, iso, marketView, positionView, wad, type Envelope} from "./model.js";
import * as S from "./schemas.js";

/**
 * Stockline public API (docs/prd/07 §2, SI-R10…R14). Mounted at `/v1`; `WS /v1/stream` is attached by the server
 * (src/stream.ts). Every data response carries `asOfBlock`, `asOfTime` and `confirmed` in the body and as
 * `X-As-Of-*` headers (SI-R13), and `X-Data-Terms` (SI-R14).
 */
export type AppConfig = Pick<
  ApiConfig,
  "chainId" | "key" | "d" | "freeRpm" | "keyedRpm" | "trustProxy" | "siweDomain" | "freeWs" | "keyedWs"
> & {trustedProxyHops?: number};

export interface AppDeps {
  db: IndexerDb;
  limiter: Limiter;
  keys: ApiKeys;
  chain: ChainReader;
  config: AppConfig;
}

type Env = {Bindings: HttpBindings; Variables: {keyId?: string; address?: string}};

export const TERMS = {
  terms:
    "Stockline short-interest data is provided as is, for information only. It is not investment advice and not an offer of securities. Values come from public onchain state of Stockline markets on Robinhood Chain and may be delayed, incomplete or revised by chain reorganizations until confirmed.",
  attribution: "Please attribute as: \"Data: Stockline (stockline.xyz)\".",
  warranty: "No warranty of any kind, express or implied, including accuracy, availability or fitness for a purpose.",
};
const TERMS_URL = "/v1/terms";

export function clientIp(c: Context<Env>, trustProxy: boolean, hops = 1): string {
  if (trustProxy) {
    const ip = ipFromForwardedFor(c.req.header("x-forwarded-for"), hops); // OFF-7: the hop our edge added
    if (ip) return ip;
  }
  return c.env?.incoming?.socket?.remoteAddress ?? "unknown";
}

const encodeCursor = (c: EventCursor) => Buffer.from(`${c.block}:${c.logIndex}`).toString("base64url");
function decodeCursor(s: string | undefined): EventCursor | undefined {
  if (!s) return undefined;
  const [b, l] = Buffer.from(s, "base64url").toString().split(":");
  if (!/^\d+$/.test(b ?? "") || !/^\d+$/.test(l ?? "")) throw new HttpError(400, "bad cursor");
  return {block: BigInt(b), logIndex: Number(l)};
}

function asOfHeaders(c: Context<Env>, e: Envelope) {
  c.header("X-As-Of-Block", e.asOfBlock);
  c.header("X-As-Of-Time", e.asOfTime);
  c.header("X-Confirmed", String(e.confirmed));
}

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({content: {"application/json": {schema}}, description});
const errors = {
  400: json(S.ErrorResponse, "Bad request"),
  404: json(S.ErrorResponse, "Not found"),
  429: json(S.ErrorResponse, "Rate limited (SI-R10)"),
  503: json(S.ErrorResponse, "Indexer not ready"),
};

export function createApp(deps: AppDeps) {
  const {db, limiter, keys, chain, config} = deps;
  const d = config.d;
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}, 400);
    },
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({error: err.message}, err.status);
    console.error(`[api] ${c.req.method} ${c.req.path}: ${safeErrorLine(err, process.env)}`); // OFF-1
    return c.json({error: "internal error"}, 500);
  });

  app.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["X-API-Key", "Content-Type"],
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      exposeHeaders: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "X-RateLimit-Tier", "X-As-Of-Block", "X-As-Of-Time", "X-Confirmed", "X-Data-Terms"],
    }),
  );

  app.get("/health", (c) => c.json({ok: true}));

  // SI-R10: free 60/min per client IP, keyed 600/min per key. SI-R14: terms link on every response.
  app.use("/v1/*", async (c, next) => {
    c.header("X-Data-Terms", TERMS_URL);
    if (c.req.method === "OPTIONS") return next();
    // OFF-8: HTTP takes the key from the header only (a `?apiKey=` lands in access logs, proxies and Referer); the
    // WebSocket upgrade still accepts it in the URL because browsers cannot set headers there.
    const key = c.req.header("x-api-key");
    let rl: string;
    let limit: number;
    if (key) {
      const k = await keys.resolve(key);
      if (!k) {
        // OFF-9: a wrong key costs the caller's free-tier budget, so random keys cannot bypass the IP limit (DB lookups).
        const r = await limiter.hit(clientKey(clientIp(c, config.trustProxy, config.trustedProxyHops)), config.freeRpm);
        if (!r.allowed) return c.json({error: "rate limit exceeded"}, 429);
        return c.json({error: "invalid or revoked API key"}, 401);
      }
      c.set("keyId", k.id);
      c.set("address", k.address);
      rl = `key:${k.id}`;
      limit = config.keyedRpm;
    } else {
      rl = clientKey(clientIp(c, config.trustProxy, config.trustedProxyHops));
      limit = config.freeRpm;
    }
    const r = await limiter.hit(rl, limit);
    c.header("X-RateLimit-Limit", String(r.limit));
    c.header("X-RateLimit-Remaining", String(r.remaining));
    c.header("X-RateLimit-Reset", String(r.reset));
    c.header("X-RateLimit-Tier", key ? "keyed" : "free");
    if (!r.allowed) {
      c.header("Retry-After", String(Math.max(1, r.reset - Math.floor(Date.now() / 1000))));
      return c.json({error: `rate limit exceeded: ${limit} requests/min for the ${key ? "keyed" : "free"} tier (SI-R10); create a key at /v1/auth/keys`}, 429);
    }
    await next();
  });

  const symbolOf = (s: string) => {
    const t = s.toUpperCase();
    if (!d.stocks[t]) throw new HttpError(404, `unknown symbol ${s}`);
    return t;
  };

  // ---------------------------------------------------------------- markets

  app.openapi(
    createRoute({method: "get", path: "/v1/markets", tags: ["markets"], summary: "All stocks, current snapshot (07 §Definitions)", responses: {200: json(S.MarketsResponse, "Snapshots"), ...errors}}),
    async (c) => {
      const [rows, head] = await Promise.all([db.latestSnapshots(), db.head()]);
      if (!rows.length) return c.json({error: "indexer has no snapshots yet"}, 503);
      const oldest = rows.reduce((a, r) => (BigInt(String(r.block_number)) < BigInt(String(a.block_number)) ? r : a));
      const e = envelope(head, BigInt(String(oldest.block_number)), BigInt(String(oldest.timestamp)));
      asOfHeaders(c, e);
      return c.json({...e, data: rows.map((r) => marketView(r, d))}, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/markets/{symbol}",
      tags: ["markets"],
      summary: "One stock: snapshot + params (LLTV, caps, U_MAX, buffer now, next session)",
      request: {params: z.object({symbol: S.Symbol})},
      responses: {200: json(S.MarketDetailResponse, "Snapshot and parameters"), ...errors},
    }),
    async (c) => {
      const t = symbolOf(c.req.valid("param").symbol);
      const [row, head, p] = await Promise.all([db.latestSnapshot(t), db.head(), chain.oracleParams(t)]);
      if (!row) return c.json({error: "indexer has no snapshot for this stock yet"}, 503);
      const s = d.stocks[t];
      const m = marketView(row, d);
      const ts = Number(row.timestamp);
      const bufferParams = {z: p.z, sigma: p.sigma, bMin: p.bMin, bMax: p.bMax, rampIn: p.rampIn};
      const nc = nextClosure(ts, bufferParams);
      const ev = nextEvent(t, ts);
      const capAssets = BigInt(s.capAssets);
      const e = envelope(head, BigInt(String(row.block_number)), BigInt(String(row.timestamp)));
      asOfHeaders(c, e);
      return c.json(
        {
          ...e,
          data: {
            ...m,
            params: {
              lltv: formatUnits(BigInt(s.lltv), 18),
              uMax: formatUnits(U_MAX_WAD, 18),
              hfMinOpen: formatUnits(HF_MIN_OPEN_WAD, 18),
              supplyCapShares: formatUnits(capAssets, 18),
              supplyCapUsd: formatUnits((capAssets * BigInt(String(row.price_answer))) / 10n ** 8n, 18),
              perAddressCapUsd: Number(s.perAddressCapUsd),
              oracle: {
                z: wad(p.z),
                sigma: wad(p.sigma),
                bMin: wad(p.bMin),
                bMax: wad(p.bMax),
                rampInSec: Number(p.rampIn),
                heartbeatSec: Number(p.stockHeartbeat),
                staleGraceSec: Number(p.staleGrace),
              },
            },
            schedule: {
              sessionOpen: Boolean(row.market_open),
              bufferNow: m.buffer,
              nextClose: nc ? iso(nc.closeTs) : null,
              rampStart: nc ? iso(nc.rampStartTs) : null,
              reopen: nc?.reopenTs ? iso(nc.reopenTs) : null,
              bufferAtClose: nc ? wad(nc.bufferAtClose) : null,
              nextEvent: ev ? {fullBy: iso(ev.startTs), release: iso(ev.endTs), buffer: wad(ev.bufferWad)} : null,
            },
            contracts: {
              stockToken: s.stockToken,
              wrapper: s.wrapper,
              oracle: s.oracle,
              vault: s.vault,
              adapter: s.adapter,
              morpho: d.morpho,
              router: d.router ?? null,
              lens: d.lens ?? null,
              marketHours: d.marketHours,
            },
          },
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/markets/{symbol}/history",
      tags: ["markets"],
      summary: "Time series of the snapshot fields (1m / 1h / 1d buckets); `format=csv` for CSV (SI-R12)",
      request: {params: z.object({symbol: S.Symbol}), query: S.HistoryQuery},
      responses: {200: {content: {"application/json": {schema: S.HistoryResponse}, "text/csv": {schema: z.string()}}, description: "History"}, ...errors},
    }),
    async (c) => {
      const t = symbolOf(c.req.valid("param").symbol);
      const q = c.req.valid("query");
      const head = await db.head();
      const now = BigInt(String(head?.head_timestamp ?? Math.floor(Date.now() / 1000)));
      const to = q.to ? BigInt(Math.floor(Date.parse(q.to) / 1000)) : now + 1n;
      const from = q.from ? BigInt(Math.floor(Date.parse(q.from) / 1000)) : to - 7n * 86_400n;
      if (from >= to) return c.json({error: "from must be before to"}, 400);
      const rows = (await db.history(t, q.interval, from, to, q.limit)).map(historyView);
      const e = envelope(head);
      asOfHeaders(c, e);
      if (q.format === "csv") {
        const cols = Object.keys(S.HistoryPoint.shape) as (keyof (typeof rows)[number])[];
        const esc = (v: unknown) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
        const body = [cols.join(","), ...rows.map((r) => cols.map((k) => esc(r[k])).join(","))].join("\n") + "\n";
        c.header("Content-Disposition", `attachment; filename="stockline-${t}-${q.interval}.csv"`);
        return c.body(body, 200, {"Content-Type": "text/csv; charset=utf-8"});
      }
      return c.json({...e, symbol: t, interval: q.interval, data: rows}, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/markets/{symbol}/events",
      tags: ["markets"],
      summary: "Event feed, newest first, paginated with `cursor`",
      request: {params: z.object({symbol: S.Symbol}), query: S.EventsQuery},
      responses: {200: json(S.EventsResponse, "Events"), ...errors},
    }),
    async (c) => {
      const t = symbolOf(c.req.valid("param").symbol);
      const q = c.req.valid("query");
      const types = q.type === "all" ? [] : [q.type];
      const [rows, head] = await Promise.all([db.events(t, types, decodeCursor(q.cursor), q.limit, q.account), db.head()]);
      const last = rows[rows.length - 1];
      const nextCursor = rows.length === q.limit && last ? encodeCursor({block: BigInt(String(last.block_number)), logIndex: Number(last.log_index)}) : null;
      const e = envelope(head);
      asOfHeaders(c, e);
      return c.json({...e, data: rows.map(eventView), nextCursor}, 200);
    },
  );

  // ---------------------------------------------------------------- positions, status, terms

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/positions/{address}",
      tags: ["positions"],
      summary: "Positions of a wallet in Stockline markets (public onchain data)",
      request: {params: z.object({address: S.Address})},
      responses: {200: json(S.PositionsResponse, "Positions"), ...errors},
    }),
    async (c) => {
      const address = c.req.valid("param").address.toLowerCase();
      const [rows, snaps, head] = await Promise.all([db.positions(address), db.latestSnapshots(), db.head()]);
      const markets = await Promise.all(Object.keys(d.stocks).map(async (t) => [t, await db.market(t)] as const));
      const snapBy = new Map(snaps.map((s) => [String(s.ticker), s]));
      const marketBy = new Map(markets);
      const data = rows
        .filter((p) => BigInt(String(p.supply_shares)) + BigInt(String(p.borrow_shares)) + BigInt(String(p.collateral)) > 0n)
        .map((p) => positionView(p, snapBy.get(String(p.ticker)), marketBy.get(String(p.ticker)), d));
      const e = envelope(head);
      asOfHeaders(c, e);
      return c.json({...e, address, data}, 200);
    },
  );

  app.openapi(
    createRoute({method: "get", path: "/v1/status", tags: ["status"], summary: "Oracle freshness, guard state and indexer lag per market", responses: {200: json(S.StatusResponse, "Status"), ...errors}}),
    async (c) => {
      const [rows, head, chainBlock] = await Promise.all([db.latestSnapshots(), db.head(), chain.blockNumber()]);
      if (!head) return c.json({error: "indexer has no head yet"}, 503);
      const headBlock = BigInt(head.head_block);
      const headTs = Number(head.head_timestamp);
      const markets = await Promise.all(
        rows.map(async (r) => {
          const t = String(r.ticker);
          const p = await chain.oracleParams(t);
          const age = headTs - Number(r.price_updated_at);
          const open = Boolean(r.market_open);
          const mask = BigInt(String(r.guard_reasons));
          const m = marketView(r, d);
          return {
            symbol: t,
            marketStatus: m.marketStatus,
            snapshotBlock: String(r.block_number),
            oracle: {usdPerToken: m.price.usdPerToken, updatedAt: m.price.feedUpdatedAt, ageSec: age, sessionOpen: open, stale: open && age > Number(p.stockHeartbeat + p.staleGrace)},
            guard: {tripped: mask !== 0n, reasons: m.guard.reasons, mask: mask.toString()},
          };
        }),
      );
      const e = envelope(head);
      asOfHeaders(c, e);
      return c.json(
        {
          ...e,
          data: {
            chainId: config.chainId,
            network: String(config.key),
            indexer: {
              headBlock: headBlock.toString(),
              headTime: iso(headTs),
              chainBlock: chainBlock === null ? null : chainBlock.toString(),
              lagBlocks: chainBlock === null ? null : Number(chainBlock - headBlock),
              safeBlock: String(head.safe_block),
              finalizedBlock: String(head.finalized_block),
            },
            markets,
          },
        },
        200,
      );
    },
  );

  // ---------------------------------------------------------------- protocol revenue (FE-R5)

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/protocol/revenue",
      tags: ["protocol"],
      summary: "Performance fees per stock per day, in Stock Token units and USD; distributions and conversions (FE-R5)",
      request: {query: S.RevenueQuery},
      responses: {200: json(S.RevenueResponse, "Revenue"), ...errors},
    }),
    async (c) => {
      const q = c.req.valid("query");
      const DAY = 86_400n;
      const dayOf = (s: string) => BigInt(Date.parse(`${s}T00:00:00Z`) / 1000);
      const today = (BigInt(Math.floor(Date.now() / 1000)) / DAY) * DAY;
      const to = q.to ? dayOf(q.to) : today;
      const from = q.from ? dayOf(q.from) : to - 89n * DAY;
      if (from > to) throw new HttpError(400, "from is after to");
      if (to - from > 3660n * DAY) throw new HttpError(400, "range above 10 years");
      const [rows, totals, head] = await Promise.all([db.feeDays(from, to), db.feeTotals(from, to + DAY), db.head()]);
      const units = (x: unknown) => formatUnits(BigInt(String(x)), 18);
      const days = rows.map((r) => ({
        day: iso(Number(r.day)).slice(0, 10),
        symbol: String(r.ticker),
        interest: units(r.interest_assets),
        fee: units(r.fee_assets),
        feeUsd: units(r.fee_usd),
        accruals: Number(r.accruals),
        raw: {interestAssets: String(r.interest_assets), feeShares: String(r.fee_shares), feeAssets: String(r.fee_assets), feeUsdWad: String(r.fee_usd)},
      }));
      const by = new Map<string, {feeShares: bigint; feeAssets: bigint; feeUsd: bigint}>();
      let usd = 0n;
      for (const r of rows) {
        const t = String(r.ticker);
        const a = by.get(t) ?? {feeShares: 0n, feeAssets: 0n, feeUsd: 0n};
        a.feeShares += BigInt(String(r.fee_shares));
        a.feeAssets += BigInt(String(r.fee_assets));
        a.feeUsd += BigInt(String(r.fee_usd));
        by.set(t, a);
        usd += BigInt(String(r.fee_usd));
      }
      const kind = (k: string) => totals.find((t) => t.kind === k);
      const dist = kind("distribution");
      const conv = kind("conversion");
      const e = envelope(head);
      asOfHeaders(c, e);
      return c.json(
        {
          ...e,
          from: iso(Number(from)),
          to: iso(Number(to + DAY - 1n)),
          rateKind: "variable" as const,
          data: {
            days,
            totals: {
              feeUsd: units(usd),
              bySymbol: [...by.entries()].map(([symbol, a]) => ({symbol, fee: units(a.feeAssets), feeUsd: units(a.feeUsd), raw: {feeShares: a.feeShares.toString(), feeAssets: a.feeAssets.toString()}})),
            },
            distributed: {count: Number(dist?.n ?? 0), usd: units(dist?.usd ?? 0)},
            converted: {count: Number(conv?.n ?? 0), usdg: formatUnits(BigInt(String(conv?.usdg ?? 0)), 6), usd: units(conv?.usd ?? 0)},
          },
        },
        200,
      );
    },
  );

  app.openapi(createRoute({method: "get", path: "/v1/terms", tags: ["status"], summary: "Data terms of use (SI-R14)", responses: {200: json(S.TermsResponse, "Terms")}}), (c) =>
    c.json(TERMS, 200),
  );

  // ---------------------------------------------------------------- API keys (SI-R10)

  app.openapi(
    createRoute({method: "get", path: "/v1/auth/nonce", tags: ["auth"], summary: "One-time nonce for a Sign-In with Ethereum message", responses: {200: json(S.NonceResponse, "Nonce")}}),
    async (c) =>
      c.json(
        {nonce: await keys.nonce(), domain: config.siweDomain, chainId: config.chainId, statement: "Create a Stockline API key. This signature does not move funds or grant any permission."},
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/auth/keys",
      tags: ["auth"],
      summary: "Create an API key by signing a SIWE message (the key is shown once)",
      request: {body: {content: {"application/json": {schema: S.CreateKeyBody}}}},
      responses: {201: json(S.CreateKeyResponse, "Created"), 401: json(S.ErrorResponse, "Bad signature"), 409: json(S.ErrorResponse, "Too many keys"), ...errors},
    }),
    async (c) => {
      const b = c.req.valid("json");
      const k = await keys.create(b.message, b.signature as `0x${string}`, b.label ?? null);
      return c.json({...k, tier: "keyed" as const}, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/auth/keys",
      tags: ["auth"],
      summary: "Keys of the wallet that owns the `X-API-Key`",
      responses: {200: json(S.KeysResponse, "Keys"), 401: json(S.ErrorResponse, "No key")},
    }),
    async (c) => {
      const address = c.get("address");
      if (!address) return c.json({error: "send X-API-Key"}, 401);
      const list = await db.keysOf(address);
      return c.json({address, keys: list.map((k) => ({id: k.id, label: k.label, createdAt: k.created_at.toISOString(), revokedAt: k.revoked_at ? k.revoked_at.toISOString() : null}))}, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/auth/keys/{id}",
      tags: ["auth"],
      summary: "Revoke one of the wallet's keys",
      request: {params: z.object({id: z.string().regex(/^[0-9a-f]{16}$/).openapi({param: {name: "id", in: "path"}})})},
      responses: {200: json(z.object({revoked: z.boolean()}), "Revoked"), 401: json(S.ErrorResponse, "No key"), 404: json(S.ErrorResponse, "Not found")},
    }),
    async (c) => {
      const address = c.get("address");
      if (!address) return c.json({error: "send X-API-Key"}, 401);
      const ok = await db.revokeKey(c.req.valid("param").id, address);
      if (!ok) return c.json({error: "no such active key for this wallet"}, 404);
      return c.json({revoked: true}, 200);
    },
  );

  app.doc31("/v1/openapi.json", openApiInfo(config));
  return app;
}

export function openApiInfo(config: Pick<ApiConfig, "chainId">) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Stockline short-interest API",
      version: "1.0.0",
      description: [
        "Live short interest for Stockline markets on Robinhood Chain (docs/prd/07). Scope: Stockline markets only.",
        "Every data response carries `asOfBlock`, `asOfTime` and `confirmed` (finalized) — SI-R13.",
        "Limits (SI-R10): free 60 req/min and 1 WebSocket connection per IP; keyed 600 req/min and 10 connections. Create a key with Sign-In with Ethereum at `POST /v1/auth/keys`.",
        "WebSocket `/v1/stream`: send `{\"channel\":\"market\",\"symbol\":\"NVDA\"}` or `{\"channel\":\"events\",\"symbol\":\"*\"}`; `\"op\":\"unsubscribe\"` to stop.",
        `Chain id ${config.chainId}. Data as is, no warranty; attribution requested (${TERMS_URL}).`,
      ].join("\n\n"),
      license: {name: "Data terms", url: "https://stockline.xyz/terms/data"},
    },
    servers: [{url: "/"}],
  };
}
