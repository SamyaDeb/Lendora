import {readFileSync} from "node:fs";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import WebSocket from "ws";
import {encodeFunctionData, parseAbiItem, parseUnits, zeroAddress} from "viem";
import {privateKeyToAccount, generatePrivateKey} from "viem/accounts";
import {createSiweMessage} from "viem/siwe";
import {api as sdkApi, feeSplitterAbi, shortInterestLensAbi, lendoraRouterAbi} from "@lendora/sdk";
import {USERS} from "@lendora/devnet";
import {startStack, type Stack} from "./harness.js";

/** SI-R10…R14 and the 07 acceptance "dashboard numbers equal lens snapshot() at the same block". */
describe("public API on the indexed seed week (SI-R10…R14)", () => {
  let s: Stack;
  let base: string;
  const get = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);
  const getJson = async (path: string, init: RequestInit = {}) => {
    const r = await get(path, init);
    expect(r.status, `${path}: ${r.status}`).toBe(200);
    return (await r.json()) as Record<string, unknown> & {data: unknown};
  };

  beforeAll(async () => {
    s = await startStack();
    base = s.api.url;
  }, 400_000);
  afterAll(async () => s?.close());

  it("SI_R13 every data endpoint carries asOfBlock, asOfTime and confirmed, in the body and in headers", async () => {
    for (const path of ["/v1/markets", "/v1/markets/NVDA", "/v1/markets/NVDA/history?interval=1h", "/v1/markets/NVDA/events", `/v1/positions/${USERS.erin}`, "/v1/status"]) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      const body = (await r.json()) as {asOfBlock: string; asOfTime: string; confirmed: boolean; scope: string};
      expect(body.asOfBlock, path).toMatch(/^\d+$/);
      expect(Number.isNaN(Date.parse(body.asOfTime)), path).toBe(false);
      expect(typeof body.confirmed, path).toBe("boolean");
      expect(body.scope).toContain("Lendora markets only");
      expect(r.headers.get("x-as-of-block")).toBe(body.asOfBlock);
      expect(r.headers.get("x-data-terms")).toBe("/v1/terms"); // SI-R14
    }
  });

  it("07 acceptance: /markets/{symbol} equals ShortInterestLens.snapshot() at the same block, for every stock", async () => {
    for (const symbol of ["SPY", "NVDA", "AAPL"]) {
      const body = (await getJson(`/v1/markets/${symbol}`)) as unknown as {asOfBlock: string; data: {stockToken: `0x${string}`; raw: Record<string, string | boolean>}};
      const lens = await s.anvil.client.readContract({
        address: s.config.d.lens!,
        abi: shortInterestLensAbi,
        functionName: "snapshot",
        args: [body.data.stockToken],
        blockNumber: BigInt(body.asOfBlock),
      });
      const raw = body.data.raw;
      expect(BigInt(raw.suppliedShares as string), symbol).toBe(lens.suppliedShares);
      expect(BigInt(raw.borrowedShares as string), symbol).toBe(lens.borrowedShares);
      expect(BigInt(raw.utilizationWad as string), symbol).toBe(lens.utilizationWad);
      expect(BigInt(raw.borrowRatePerSecWad as string), symbol).toBe(lens.borrowRatePerSecWad);
      expect(BigInt(raw.bufferWad as string), symbol).toBe(lens.bufferWad);
      expect(raw.marketOpen, symbol).toBe(lens.marketOpen);
      expect(BigInt(raw.guardReasons as string) !== 0n, symbol).toBe(lens.guardTripped);
    }
  });

  it("07 acceptance holds mid-ramp too: Friday 18:00 ET with a new borrow and the buffer ramping", async () => {
    const fri = s.seed!.times.rampStart + 7_200n + 7n * 86_400n; // the next Friday, 2h into the ramp
    await s.drv.freshRounds(fri);
    await s.drv.borrow("SPY", USERS.judy, 40_000n * 10n ** 6n, 10n * 10n ** 18n);
    await s.drv.poke();
    await s.sync();
    await new Promise((r) => setTimeout(r, 300));
    const body = (await getJson("/v1/markets/SPY")) as unknown as {asOfBlock: string; data: {stockToken: `0x${string}`; marketStatus: string; raw: Record<string, string>}};
    expect(body.data.marketStatus).toBe("ramping");
    const lens = await s.anvil.client.readContract({address: s.config.d.lens!, abi: shortInterestLensAbi, functionName: "snapshot", args: [body.data.stockToken], blockNumber: BigInt(body.asOfBlock)});
    expect(lens.bufferWad).toBeGreaterThan(0n);
    expect(BigInt(body.data.raw.bufferWad)).toBe(lens.bufferWad);
    expect(BigInt(body.data.raw.borrowedShares)).toBe(lens.borrowedShares);
    expect(BigInt(body.data.raw.borrowRatePerSecWad)).toBe(lens.borrowRatePerSecWad);
  });

  it("GET /markets returns all stocks with the 07 fields as decimal strings", async () => {
    const body = (await getJson("/v1/markets")) as unknown as {data: {symbol: string; supplied: string; borrowApr: string; rateKind: string; marketStatus: string}[]};
    expect(body.data.map((m) => m.symbol)).toEqual(["AAPL", "NVDA", "SPY"]);
    for (const m of body.data) {
      expect(m.supplied).toMatch(/^\d+(\.\d+)?$/);
      expect(m.rateKind).toBe("variable"); // CP-R7
    }
  });

  it("GET /markets/{symbol} adds params (LLTV, caps, U_MAX) and the next session with the buffer at close", async () => {
    const {data} = (await getJson("/v1/markets/NVDA")) as unknown as {data: {params: {lltv: string; uMax: string; perAddressCapUsd: number; oracle: {rampInSec: number}}; schedule: {nextClose: string; rampStart: string; bufferAtClose: string}}};
    expect(data.params.lltv).toBe("0.77");
    expect(data.params.uMax).toBe("0.9");
    expect(data.params.perAddressCapUsd).toBe(250_000);
    expect(data.params.oracle.rampInSec).toBe(14_400);
    expect(Date.parse(data.schedule.nextClose) - Date.parse(data.schedule.rampStart)).toBe(4 * 3600 * 1000);
    expect(Number(data.schedule.bufferAtClose)).toBeGreaterThan(0.09);
    expect((await get("/v1/markets/TSLA")).status).toBe(404);
  });

  it("SI_R12 history as JSON and as CSV with the same rows", async () => {
    const q = "interval=1h&from=2026-09-29T00:00:00Z&to=2026-10-20T00:00:00Z";
    const js = (await getJson(`/v1/markets/NVDA/history?${q}`)) as unknown as {data: {bucket: string; borrowed: string}[]};
    expect(js.data.length).toBeGreaterThan(10);
    const r = await get(`/v1/markets/NVDA/history?${q}&format=csv`);
    expect(r.headers.get("content-type")).toContain("text/csv");
    const lines = (await r.text()).trim().split("\n");
    expect(lines[0].split(",")).toContain("borrowed");
    expect(lines.length - 1).toBe(js.data.length);
    expect(lines[1].split(",")[0]).toBe(js.data[0].bucket);
  });

  it("events: type filter and cursor pagination walk the whole feed without repeats", async () => {
    const liq = (await getJson("/v1/markets/NVDA/events?type=liquidate")) as unknown as {data: {type: string; account: string}[]};
    expect(liq.data).toHaveLength(1);
    expect(liq.data[0].account.toLowerCase()).toBe(USERS.erin.toLowerCase());
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = (await getJson(`/v1/markets/NVDA/events?limit=7${cursor ? `&cursor=${cursor}` : ""}`)) as unknown as {data: {id: string}[]; nextCursor: string | null};
      for (const e of page.data) {
        expect(seen.has(e.id)).toBe(false);
        seen.add(e.id);
      }
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 100);
    expect(pages).toBeGreaterThan(2);
    expect((await get("/v1/markets/NVDA/events?cursor=bogus")).status).toBe(400);
  });

  it("history: a from/to that is not an ISO time is a 400, not a 500 (found by testnetBreak on 46630)", async () => {
    for (const q of ["from=abc", "to=abc", "from=99999999999&to=1", "from=1&to=99999999999&interval=1m", "from=2026-13-45T00:00:00Z"]) {
      const r = await get(`/v1/markets/NVDA/history?${q}`);
      expect(r.status, q).toBe(400);
      expect(((await r.json()) as {error: string}).error, q).toBeTruthy();
    }
  });

  it("positions: health factor and debt equal the router's view at the snapshot block (OR-R22)", async () => {
    const body = (await getJson(`/v1/positions/${USERS.heidi}`)) as unknown as {asOfBlock: string; data: {symbol: string; healthFactor: string}[]};
    const nvda = body.data.find((p) => p.symbol === "NVDA")!;
    const snap = (await getJson("/v1/markets/NVDA")) as unknown as {asOfBlock: string; data: {time: string}};
    const block = BigInt(snap.asOfBlock);
    const t = BigInt(Date.parse(snap.data.time) / 1000);
    const hf = await s.anvil.client.readContract({address: s.config.d.router!, abi: lendoraRouterAbi, functionName: "healthFactorAt", args: [s.config.d.stocks.NVDA.stockToken, USERS.heidi, t], blockNumber: block});
    expect(parseUnits(nvda.healthFactor, 18)).toBe(hf); // exact, WAD
  });

  it("status: oracle freshness, guard state and indexer lag per market", async () => {
    const {data} = (await getJson("/v1/status")) as unknown as {data: {indexer: {lagBlocks: number}; markets: {symbol: string; oracle: {stale: boolean}; guard: {tripped: boolean}}[]}};
    expect(data.indexer.lagBlocks).toBeLessThanOrEqual(3);
    expect(data.markets).toHaveLength(3);
    for (const m of data.markets) expect(m.guard.tripped).toBe(false);
  });

  it("SI_R10 free tier is rate limited per IP; a SIWE-created key gets the keyed tier and can be revoked", async () => {
    const limited = await s.startApi({freeRpm: 3, keyedRpm: 6});
    const ip = {"x-forwarded-for": "203.0.113.7"};
    for (let i = 0; i < 3; i++) expect((await fetch(`${limited.url}/v1/terms`, {headers: ip})).status).toBe(200);
    const blocked = await fetch(`${limited.url}/v1/terms`, {headers: ip});
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).not.toBeNull();
    expect((await fetch(`${limited.url}/v1/terms`, {headers: {"x-forwarded-for": "203.0.113.8"}})).status).toBe(200); // other IP

    // Sign-In with Ethereum → key (shown once).
    const account = privateKeyToAccount(generatePrivateKey());
    const {nonce} = (await (await fetch(`${limited.url}/v1/auth/nonce`, {headers: {"x-forwarded-for": "203.0.113.9"}})).json()) as {nonce: string};
    const message = createSiweMessage({address: account.address, chainId: 31337, domain: "localhost", nonce, uri: "http://localhost", version: "1", statement: "Create a Lendora API key."});
    const signature = await account.signMessage({message});
    const created = await fetch(`${limited.url}/v1/auth/keys`, {method: "POST", headers: {"content-type": "application/json", "x-forwarded-for": "203.0.113.9"}, body: JSON.stringify({message, signature, label: "test"})});
    expect(created.status).toBe(201);
    const {key, id} = (await created.json()) as {key: string; id: string};
    // A replayed nonce is rejected.
    const replay = await fetch(`${limited.url}/v1/auth/keys`, {method: "POST", headers: {"content-type": "application/json", "x-forwarded-for": "203.0.113.10"}, body: JSON.stringify({message, signature})});
    expect(replay.status).toBe(401);

    const keyed = {"x-api-key": key, ...ip};
    const r = await fetch(`${limited.url}/v1/terms`, {headers: keyed});
    expect(r.status).toBe(200); // the IP is exhausted, the key is not
    expect(r.headers.get("x-ratelimit-tier")).toBe("keyed");
    expect(r.headers.get("x-ratelimit-limit")).toBe("6");
    const list = (await (await fetch(`${limited.url}/v1/auth/keys`, {headers: keyed})).json()) as {address: string; keys: {id: string}[]};
    expect(list.address).toBe(account.address.toLowerCase());
    expect(list.keys.map((k) => k.id)).toEqual([id]);
    expect((await fetch(`${limited.url}/v1/auth/keys/${id}`, {method: "DELETE", headers: keyed})).status).toBe(200);
    expect((await fetch(`${limited.url}/v1/terms`, {headers: {"x-api-key": key, "x-forwarded-for": "203.0.113.11"}})).status).toBe(401);
    expect((await fetch(`${limited.url}/v1/terms`, {headers: keyed})).status).toBe(429); // OFF-9: this IP's free budget is spent
    // Stored: key hash + address only (APP-R11: no IP column).
    const {rows} = await s.api.db.pool.query(`select * from "${s.config.apiSchema}".api_keys`);
    expect(Object.keys(rows[0]).sort()).toEqual(["address", "created_at", "id", "key_hash", "label", "revoked_at"]);
    expect(JSON.stringify(rows)).not.toContain(key);
  });

  it("OFF_7 OFF_8 OFF_9 rate limits key on the edge's XFF hop, ignore ?apiKey= on HTTP, and charge wrong keys", async () => {
    const limited = await s.startApi({freeRpm: 2});
    const get = (h: Record<string, string>, q = "") => fetch(`${limited.url}/v1/terms${q}`, {headers: h});
    // OFF-7: the client-controlled left part of X-Forwarded-For does not pick the bucket; the right-most hop does.
    expect((await get({"x-forwarded-for": "1.1.1.1, 203.0.113.50"})).status).toBe(200);
    expect((await get({"x-forwarded-for": "2.2.2.2, 203.0.113.50"})).status).toBe(200);
    expect((await get({"x-forwarded-for": "3.3.3.3, 203.0.113.50"})).status).toBe(429);
    // OFF-8: a key in the query string is ignored on HTTP (free tier, not 401).
    const q = await get({"x-forwarded-for": "203.0.113.52"}, "?apiKey=sk_whatever");
    expect(q.status).toBe(200);
    expect(q.headers.get("x-ratelimit-tier")).toBe("free");
    // OFF-9: wrong keys cost the IP's free budget: 401, 401, then 429.
    const bad = {"x-forwarded-for": "203.0.113.51", "x-api-key": "sk_not_a_key"};
    expect((await get(bad)).status).toBe(401);
    expect((await get(bad)).status).toBe(401);
    expect((await get(bad)).status).toBe(429);
  });

  it("OFF_11 WS: a connection that floods messages is closed (1008)", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/v1/stream`, {headers: {"x-forwarded-for": "198.51.100.77"}});
    await new Promise((r) => ws.once("open", r));
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    for (let i = 0; i < 30; i++) ws.send(JSON.stringify({channel: "market", symbol: "NVDA"}));
    expect(await closed).toBe(1008);
  });

  it("SI_R10 / SI_R11 WS: subscribe, receive the snapshot, get pushed within 2 s of the block; free tier = 1 connection", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/v1/stream`, {headers: {"x-forwarded-for": "198.51.100.1"}});
    const msgs: {channel?: string; symbol?: string; asOfBlock?: string; data?: {type?: string}; at: number}[] = [];
    ws.on("message", (m) => msgs.push({...JSON.parse(m.toString()), at: Date.now()}));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({channel: "market", symbol: "NVDA"}));
    ws.send(JSON.stringify({channel: "events", symbol: "*"}));
    await new Promise((r) => setTimeout(r, 300));
    expect(msgs.some((m) => m.channel === "market" && m.symbol === "NVDA")).toBe(true);

    // A second free connection from the same IP is refused (SI-R10).
    const second = new WebSocket(`${base.replace("http", "ws")}/v1/stream`, {headers: {"x-forwarded-for": "198.51.100.1"}});
    const code = await new Promise<number>((resolve) => second.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
    expect(code).toBe(429);

    // Push latency: a borrow at block B must reach the client within 2 s (SI-R11).
    const before = msgs.length;
    const t0 = Date.now();
    const receipt = await s.drv.borrow("NVDA", USERS.judy, 30_000n * 10n ** 6n, 10n * 10n ** 18n);
    const tBlock = Date.now();
    const deadline = t0 + 5000;
    while (Date.now() < deadline && !msgs.slice(before).some((m) => m.channel === "events" && BigInt(m.asOfBlock ?? 0) >= receipt.blockNumber)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const pushed = msgs.slice(before).find((m) => m.channel === "events" && BigInt(m.asOfBlock ?? 0) >= receipt.blockNumber)!;
    const marketPush = msgs.slice(before).find((m) => m.channel === "market" && BigInt(m.asOfBlock ?? 0) >= receipt.blockNumber);
    console.log(`[SI-R11] WS push after the block: events ${pushed.at - tBlock} ms, market ${marketPush ? marketPush.at - tBlock : "n/a"} ms`);
    expect(pushed.at - tBlock).toBeLessThan(2000);
    ws.close();
  });

  it("SI_R10 fan-out through Redis: two API instances, one publisher, both push to their clients", async () => {
    const redis = await (await import("@lendora/devnet")).startRedis();
    const instances: Awaited<ReturnType<Stack["startApi"]>>[] = [];
    try {
      const a1 = await s.startApi({redisUrl: redis.url});
      const a2 = await s.startApi({redisUrl: redis.url});
      instances.push(a1, a2);
      const got = [0, 0];
      const socks = [a1, a2].map((a, i) => {
        const w = new WebSocket(`${a.url.replace("http", "ws")}/v1/stream`, {headers: {"x-forwarded-for": `192.0.2.${i + 1}`}});
        w.on("message", (m) => {
          const j = JSON.parse(m.toString());
          if (j.channel === "events") got[i]++;
        });
        return w;
      });
      await Promise.all(socks.map((w) => new Promise((r) => w.once("open", r))));
      for (const w of socks) w.send(JSON.stringify({channel: "events", symbol: "*"}));
      await new Promise((r) => setTimeout(r, 1500)); // let one instance take the leader lease and set its cursor
      await s.drv.poke(["AAPL", "SPY"]);
      await s.drv.guardian("AAPL", "trip");
      await s.drv.guardian("AAPL", "clear");
      const deadline = Date.now() + 5000;
      while ((got[0] === 0 || got[1] === 0) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(got[0]).toBeGreaterThan(0);
      expect(got[1]).toBe(got[0]); // same stream on both instances
      for (const w of socks) w.close();
    } finally {
      for (const i of instances) await i.close(); // before Redis goes away
      redis.stop();
    }
  });

  it("FE-R5 acceptance: /protocol/revenue fee shares = the sum of onchain fee transfers (vault mints to the FeeSplitter)", async () => {
    const splitter = s.anvil.d.feeSplitter!;
    const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
    const onchain: Record<string, bigint> = {};
    for (const [t, st] of Object.entries(s.anvil.d.stocks)) {
      const logs = await s.anvil.client.getLogs({address: st.vault, event: transfer, args: {from: zeroAddress, to: splitter}, fromBlock: 0n});
      onchain[t] = logs.reduce((acc, l) => acc + l.args.value!, 0n);
    }
    const total = Object.values(onchain).reduce((a, b) => a + b, 0n);
    expect(total > 0n, "the seed week accrued fees").toBe(true);
    const body = (await getJson("/v1/protocol/revenue?from=2026-01-01&to=2027-12-31")) as unknown as {
      rateKind: string;
      data: {days: {symbol: string; raw: {feeShares: string; feeAssets: string; interestAssets: string}}[]; totals: {feeUsd: string; bySymbol: {symbol: string; raw: {feeShares: string}}[]}};
    };
    expect(body.rateKind).toBe("variable"); // CP-R7
    for (const b of body.data.totals.bySymbol) expect(BigInt(b.raw.feeShares), b.symbol).toBe(onchain[b.symbol]);
    expect(body.data.totals.bySymbol.reduce((a, b) => a + BigInt(b.raw.feeShares), 0n)).toBe(total);
    for (const d of body.data.days) {
      // fee = 10% of interest, rounded down per accrual (FE-R1)
      const i = BigInt(d.raw.interestAssets);
      const f = BigInt(d.raw.feeAssets);
      expect(f <= i / 10n && f + 50n >= i / 10n, `${d.symbol} fee ~ 10% of interest`).toBe(true);
    }
    expect(Number(body.data.totals.feeUsd)).toBeGreaterThan(0);

    // A distribution is indexed with its USD value; the endpoint reports it.
    const before = (await getJson("/v1/protocol/revenue?from=2026-01-01&to=2027-12-31")) as unknown as {data: {distributed: {count: number}}};
    await s.anvil.send(USERS.erin, splitter, encodeFunctionData({abi: feeSplitterAbi, functionName: "distribute", args: [s.anvil.d.stocks.NVDA.vault]}));
    await s.sync();
    const after = (await getJson("/v1/protocol/revenue?from=2026-01-01&to=2027-12-31")) as unknown as {data: {distributed: {count: number; usd: string}}};
    expect(after.data.distributed.count).toBe(before.data.distributed.count + 2); // treasury + backstop converters
    expect(Number(after.data.distributed.usd)).toBeGreaterThan(0);
    expect((await get("/v1/protocol/revenue?from=2026-02-01&to=2026-01-01")).status).toBe(400);
  });

  it("OpenAPI 3.1 is served, matches api/openapi.json, and the SDK's typed client reads the API", async () => {
    const doc = (await (await get("/v1/openapi.json")).json()) as {openapi: string; paths: Record<string, unknown>};
    expect(doc.openapi).toBe("3.1.0");
    for (const p of ["/v1/markets", "/v1/markets/{symbol}", "/v1/markets/{symbol}/history", "/v1/markets/{symbol}/events", "/v1/positions/{address}", "/v1/status", "/v1/auth/keys"]) {
      expect(doc.paths[p], p).toBeDefined();
    }
    const committed = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {paths: Record<string, unknown>};
    expect(Object.keys(committed.paths).sort()).toEqual(Object.keys(doc.paths).sort());
    const client = sdkApi.createClient(base);
    const markets = await client.markets();
    expect(markets.data.map((m) => m.symbol)).toEqual(["AAPL", "NVDA", "SPY"]);
    const status = await client.status();
    expect(status.data.chainId).toBe(31337);
    await expect(client.market("NOPE")).rejects.toThrow(/unknown symbol/);
  });
});

describe("OFF-10 in-memory SIWE nonces are bounded", () => {
  it("OFF_10 the store never holds more than its bound, dropping expired then oldest nonces", async () => {
    const {MemoryNonceStore} = await import("../src/keys.js");
    const n = new MemoryNonceStore(100);
    for (let i = 0; i < 1_000; i++) await n.put(`n${i}`, 600);
    expect(n.size).toBeLessThanOrEqual(100);
    expect(await n.take("n999")).toBe(true);
    expect(await n.take("n0")).toBe(false);
  });
});
