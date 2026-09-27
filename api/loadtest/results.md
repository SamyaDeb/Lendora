# API load test (SI-R11)

Run: `pnpm --filter @stockline/api loadtest --seconds 60 --clients 200 --rps 50` on 2026-09-27T16:16:57.909Z
(local stack: anvil seed week → Ponder → Postgres → API with Redis fan-out; one machine generates all traffic).

| Metric | Result | Target (SI-R11) |
|---|---|---|
| REST requests | 3019 at 50.3 req/s, 0 non-2xx, 0 errors | 50 req/s |
| REST latency | p50 6 ms, p90 14 ms, p97.5 21 ms, p99 27 ms, max 48 ms | p95 < 200 ms |
| WS clients | 200 concurrent, 11800/11800 block pushes received | 200 |
| WS push after the block | p50 155 ms, p95 231 ms, p99 240 ms, max 242 ms | within 2 s |
