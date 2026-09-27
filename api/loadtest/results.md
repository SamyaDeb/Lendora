# API load test (SI-R11)

Run: `pnpm --filter @stockline/api loadtest --seconds 30 --clients 200 --rps 50` on 2026-09-27T08:20:58.461Z
(local stack: anvil seed week → Ponder → Postgres → API with Redis fan-out; one machine generates all traffic).

| Metric | Result | Target (SI-R11) |
|---|---|---|
| REST requests | 1527 at 50.9 req/s, 0 non-2xx, 0 errors | 50 req/s |
| REST latency | p50 7 ms, p90 20 ms, p97.5 33 ms, p99 42 ms, max 58 ms | p95 < 200 ms |
| WS clients | 200 concurrent, 6000/6000 block pushes received | 200 |
| WS push after the block | p50 161 ms, p95 246 ms, p99 268 ms, max 269 ms | within 2 s |
