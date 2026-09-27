/**
 * SI-R11 load test (07 acceptance): 200 concurrent WebSocket clients + 50 req/s REST on the snapshot endpoints, on
 * the full local stack (anvil seed week → Ponder → Postgres → API with Redis). Measures REST latency (autocannon)
 * and WS push latency from the block to each client, while the chain driver produces a state change every second.
 *
 *   pnpm --filter @stockline/api loadtest [--seconds 60] [--clients 200] [--rps 50]
 *
 * Writes api/loadtest/results.md. Limits are raised for the test (one process generates all the traffic).
 */
import {writeFileSync} from "node:fs";
import autocannon from "autocannon";
import WebSocket from "ws";
import {encodeFunctionData} from "viem";
import {stocklineOracleAbi} from "@stockline/sdk";
import {startStack} from "../test/harness.js";

const arg = (n: string, d: number) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const SECONDS = arg("seconds", 60);
const CLIENTS = arg("clients", 200);
const RPS = arg("rps", 50);

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
};

console.log(`[load] starting the stack (anvil seed week, indexer, API with Redis)…`);
const s = await startStack({redis: true, api: {freeRpm: 1_000_000, keyedRpm: 1_000_000, freeWs: 1_000, streamPollMs: 100}});
const wsUrl = `${s.api.url.replace("http", "ws")}/v1/stream`;

// 200 WS clients, each subscribed to one market and to all events.
const symbols = ["SPY", "NVDA", "AAPL"];
const pushes: {block: bigint; at: number}[][] = [];
const sockets: WebSocket[] = [];
for (let i = 0; i < CLIENTS; i++) {
  const w = new WebSocket(wsUrl, {headers: {"x-forwarded-for": `10.0.${Math.floor(i / 250)}.${i % 250}`}});
  const mine: {block: bigint; at: number}[] = [];
  pushes.push(mine);
  w.on("message", (m) => {
    const j = JSON.parse(m.toString());
    if (j.channel === "events" && j.asOfBlock) mine.push({block: BigInt(j.asOfBlock), at: Date.now()});
  });
  sockets.push(w);
}
await Promise.all(sockets.map((w) => new Promise((r) => w.once("open", r))));
sockets.forEach((w, i) => {
  w.send(JSON.stringify({channel: "market", symbol: symbols[i % 3]}));
  w.send(JSON.stringify({channel: "events", symbol: "*"}));
});
console.log(`[load] ${sockets.length} WebSocket clients connected and subscribed`);
await new Promise((r) => setTimeout(r, 1500));

// A state change every second (a guardian trip/clear alternates on AAPL; each emits GuardChanged).
const blockTimes = new Map<bigint, number>();
let running = true;
const driver = (async () => {
  let n = 0;
  while (running) {
    const data = encodeFunctionData({abi: stocklineOracleAbi, functionName: n++ % 2 === 0 ? "trip" : "clear", args: [1n]});
    const r = await s.drv.a.send(s.drv.d.roles.guardian, s.drv.stock("AAPL").oracle, data).catch(() => undefined);
    if (r) blockTimes.set(r.blockNumber, Date.now());
    await new Promise((res) => setTimeout(res, 1000));
  }
})();

// REST: 50 req/s spread over the snapshot endpoints.
const rest = await autocannon({
  url: s.api.url,
  connections: 20,
  overallRate: RPS,
  duration: SECONDS,
  requests: [{method: "GET", path: "/v1/markets"}, {method: "GET", path: "/v1/markets/NVDA"}, {method: "GET", path: "/v1/markets/SPY"}, {method: "GET", path: "/v1/status"}],
});
running = false;
await driver;
await new Promise((r) => setTimeout(r, 2500));

// WS push latency: first push per client at or after each driven block.
const lat: number[] = [];
for (const [block, t] of blockTimes) {
  for (const mine of pushes) {
    const p = mine.find((x) => x.block >= block);
    if (p) lat.push(p.at - t);
  }
}
const expected = blockTimes.size * CLIENTS;
const report = {
  date: new Date().toISOString(),
  rest: {
    requests: rest.requests.total,
    rps: rest.requests.average,
    non2xx: rest.non2xx,
    errors: rest.errors,
    latencyMs: {p50: rest.latency.p50, p90: rest.latency.p90, p97_5: rest.latency.p97_5, p99: rest.latency.p99, max: rest.latency.max},
  },
  ws: {clients: CLIENTS, blocks: blockTimes.size, pushes: lat.length, expected, latencyMs: {p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: Math.max(...lat)}},
};
console.log(JSON.stringify(report, null, 2));
const md = `# API load test (SI-R11)

Run: \`pnpm --filter @stockline/api loadtest --seconds ${SECONDS} --clients ${CLIENTS} --rps ${RPS}\` on ${report.date}
(local stack: anvil seed week → Ponder → Postgres → API with Redis fan-out; one machine generates all traffic).

| Metric | Result | Target (SI-R11) |
|---|---|---|
| REST requests | ${report.rest.requests} at ${report.rest.rps.toFixed(1)} req/s, ${report.rest.non2xx} non-2xx, ${report.rest.errors} errors | 50 req/s |
| REST latency | p50 ${report.rest.latencyMs.p50} ms, p90 ${report.rest.latencyMs.p90} ms, p97.5 ${report.rest.latencyMs.p97_5} ms, p99 ${report.rest.latencyMs.p99} ms, max ${report.rest.latencyMs.max} ms | p95 < 200 ms |
| WS clients | ${CLIENTS} concurrent, ${report.ws.pushes}/${expected} block pushes received | 200 |
| WS push after the block | p50 ${report.ws.latencyMs.p50} ms, p95 ${report.ws.latencyMs.p95} ms, p99 ${report.ws.latencyMs.p99} ms, max ${report.ws.latencyMs.max} ms | within 2 s |
`;
writeFileSync(new URL("./results.md", import.meta.url), md);
for (const w of sockets) w.close();
await s.close();
process.exit(0);
