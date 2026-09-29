# Testnet smoke

> **Rehearsal, not testnet.** No "go testnet" yet: this run is `testnetSmoke.ts` against the **local full stack**
> (`web/scripts/liveStack.ts`, anvil 31337 with the DeployLocal fixture: web `next start`, API, indexer, compliance;
> the NAV report was submitted by `liveChain.ts nav` in place of the reporter keeper; no monitor running, so the
> weekend-log check is skipped). The 46630 contracts, fee turn-on, DN vault deploy and flows were rehearsed on an anvil
> fork of 46630 ([fork-drills-46630.md](fork-drills-46630.md)). After the go, re-run against the hosted URLs:
> `SMOKE_KEY=… TESTNET_GO=yes pnpm --filter @stockline/web exec tsx scripts/testnetSmoke.ts --web <APP_URL> --api <API_URL>
> --rpc https://rpc.testnet.chain.robinhood.com --monitor <MONITOR_URL> --flows --report ../docs/runbooks/testnet-smoke.md`.

Run 2026-09-29T09:15:25.426Z by `web/scripts/testnetSmoke.ts` (6 s) against chain 31337:
web http://127.0.0.1:3002, API http://127.0.0.1:52279, compliance http://127.0.0.1:52281. With user flows.
**All checks passed** (1 skipped).

| Area | Check | Result | Detail |
|---|---|---|---|
| API | /v1/status: indexer caught up | ok | lag 0; AAPL open, NVDA open, SPY open |
| API | /v1/markets (lend, borrow, short-interest data) | ok | AAPL, NVDA, SPY |
| API | /v1/markets/NVDA | ok | 200 at block 576 |
| API | /v1/markets/NVDA/history | ok | 200 at block 576 |
| API | /v1/markets/NVDA/events | ok | 200 at block 576 |
| API | /v1/positions/0x0000000000000000000000000000000000000001 | ok | 200 at block 576 |
| API | /v1/protocol/revenue | ok | 200 at block 576 |
| API | /v1/terms | ok | 200 |
| API | /v1/receipt-markets | ok | 200 at block 576 |
| API | /v1/vault/overview (USDG Earn) | ok | tvl 45, cap 2000000, deposits open, NAV fresh |
| API | /v1/openapi.json lists every route | ok | 14 paths |
| Web | GET / | ok | 42673 bytes |
| Web | GET /markets | ok | 50504 bytes |
| Web | GET /stock/NVDA | ok | 82558 bytes |
| Web | GET /stock/NVDA?tab=lend | ok | 82628 bytes |
| Web | GET /stock/NVDA?tab=short | ok | 84256 bytes |
| Web | GET /market/NVDA | ok | 82583 bytes (→ /stock/NVDA) |
| Web | GET /portfolio | ok | 23974 bytes |
| Web | GET /data | ok | 108295 bytes |
| Web | GET /short-interest | ok | 108290 bytes (→ /data) |
| Web | GET /vault | ok | 23451 bytes |
| Web | GET /alerts | ok | 21696 bytes |
| Web | GET /terms | ok | 25337 bytes |
| Web | GET /status | ok | 26490 bytes |
| Web | GET /restricted | ok | 21659 bytes |
| Web | geo-block: x-vercel-ip-country=US on /markets renders the restricted page (APP-R2) | ok | rewritten to /restricted |
| Web | compliance proxy: terms text through /api/compliance | ok | terms 2026-09-27.1 |
| Compliance | /health: signer and sanctions provider | ok | signer 0x8f207b38aE2478837b4cF4e111026407a0E5F86f, sanctions deny-list |
| Monitor | /health and GET /weekends (weekend log accrues) | skip | no --monitor URL |
| Flows | terms signed + attestation through the web's compliance proxy | ok | expiry 2026-10-07T20:07:03.000Z |
| Flows | lend, short, rescue top-up, repay, close, borrow, withdraw (05 §4) | ok | 11 txs: lend, openShort, addCollateral, repay, closeShort, borrow, withdrawCollateral, withdrawLend |
| Flows | USDG Earn: deposit, instant withdrawal, queued request, settle, claim | ok | deposit → withdraw → requestRedeem → settle → claim |
| API | the smoke wallet's position is indexed | ok | 2 bytes |
