# Testnet smoke

Run 2026-09-29T13:23:00.559Z by `web/scripts/testnetSmoke.ts` (131 s) against chain 46630:
web http://127.0.0.1:3000, API http://127.0.0.1:42070, compliance http://127.0.0.1:42071, monitor http://127.0.0.1:42073. With user flows.
**1 check(s) failed** (0 skipped).

| Area | Check | Result | Detail |
|---|---|---|---|
| API | /v1/status: indexer caught up | ok | lag 5; AAPL open, NVDA open, SPY open |
| API | /v1/markets (lend, borrow, short-interest data) | ok | AAPL, NVDA, SPY |
| API | /v1/markets/NVDA | ok | 200 at block 126215499 |
| API | /v1/markets/NVDA/history | ok | 200 at block 126216010 |
| API | /v1/markets/NVDA/events | ok | 200 at block 126216010 |
| API | /v1/positions/0x0000000000000000000000000000000000000001 | ok | 200 at block 126216011 |
| API | /v1/protocol/revenue | ok | 200 at block 126216011 |
| API | /v1/terms | ok | 200 |
| API | /v1/receipt-markets | ok | 200 at block 126216012 |
| API | /v1/vault/overview (USDG Earn) | ok | tvl 67.5, cap 1000000, deposits open, NAV fresh |
| API | /v1/openapi.json lists every route | ok | 14 paths |
| Web | GET / | ok | 46055 bytes |
| Web | GET /markets | ok | 56680 bytes |
| Web | GET /stock/NVDA | ok | 87573 bytes |
| Web | GET /stock/NVDA?tab=lend | ok | 88139 bytes |
| Web | GET /stock/NVDA?tab=short | ok | 89779 bytes |
| Web | GET /market/NVDA | ok | 88094 bytes (→ /stock/NVDA) |
| Web | GET /portfolio | ok | 30475 bytes |
| Web | GET /data | ok | 100739 bytes |
| Web | GET /short-interest | ok | 101335 bytes (→ /data) |
| Web | GET /vault | ok | 29946 bytes |
| Web | GET /alerts | ok | 28593 bytes |
| Web | GET /terms | ok | 32114 bytes |
| Web | GET /status | ok | 34399 bytes |
| Web | GET /restricted | ok | 28687 bytes |
| Web | geo-block: x-geo-country=US on /markets renders the restricted page (APP-R2) | **FAIL** | no restricted page: GEO_PLATFORM header name, or the country is allowed? |
| Web | compliance proxy: terms text through /api/compliance | ok | terms 2026-09-27.1 |
| Compliance | /health: signer and sanctions provider | ok | signer 0x5A53565Ce2dc679c95499BD0afB561736c607a6B, sanctions deny-list |
| Monitor | /health and GET /weekends (weekend log accrues) | ok | 0 closure(s) logged |
| Flows | terms signed + attestation through the web's compliance proxy | ok | expiry 2026-09-30T13:20:55.000Z |
| Flows | lend, short, rescue top-up, repay, close, borrow, withdraw (05 §4) | ok | 11 txs: lend, openShort, addCollateral, repay, closeShort, borrow, withdrawCollateral, withdrawLend |
| Flows | USDG Earn: deposit, instant withdrawal, queued request, settle, claim | ok | deposit → withdraw → requestRedeem → settle → claim |
| API | the smoke wallet's position is indexed | ok | 2 bytes |

**Note (2026-09-29, local stack against 46630).** The geo-block check fails by design here: `scripts/dev.sh --network
46630` runs the web with `GEO_PLATFORM=static GEO_STATIC_COUNTRY=DE`, which ignores request geo headers (a spoofed
header must never pick the country, CP-R8), so `x-geo-country=US` cannot reach the restricted page. It is covered by
`web/test/complianceProxy.test.ts` and needs a hosted edge (`GEO_PLATFORM=vercel|cloudflare`) to check end to end;
locally, restart the web with `GEO_STATIC_COUNTRY=US` to see the restricted page. Every other check passes, including
all user flows and the USDG Earn cycle on testnet from a plain tester wallet (no roles).
