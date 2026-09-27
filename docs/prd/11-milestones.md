# 11 · Milestones and build order

Build in this order. Each phase has exit criteria that gate the next. Durations are estimates for a team of 2 Solidity, 2
TypeScript/full-stack and 1 risk/quant person.

| Phase | Focus | Est. | Exit criteria |
|---|---|---|---|
| 0 | Validation | 3 weeks | All [VERIFY] items in [12](12-open-questions.md) answered; 15 borrower interviews; go/no-go memo |
| 1 | Lending core contracts | 6 weeks | [03](03-lending-markets.md), [04](04-oracle.md), [05](05-collateral-router.md) acceptance criteria pass on fork |
| 2 | App, indexer, API, testnet | 6 weeks | [06](06-web-app.md), [07](07-short-interest.md) acceptance; 2 testnet weekends clean; 20 external testers |
| 3 | Audit, guarded mainnet | 6–8 weeks | 2 audits closed; runbooks drilled; mainnet with caps in [10](10-risk-compliance.md); fees live ([09 §1](09-backstop-fees.md)) |
| 4 | Delta-neutral vault | 8 weeks after sim gate | [08](08-delta-neutral-vault.md) sim gate, audit, 30-day run |
| 5 | Backstop, then token later | TBD | [09 §2](09-backstop-fees.md) acceptance; token only with revenue + legal |

## Phase 1 task breakdown (lending core)

Ordered so each task unblocks the next. IDs map to requirements.

1. **Repo scaffold.** Monorepo per [02](02-architecture.md); Foundry with Morpho Blue + Vault V2 submodules; CI (forge test, fmt, slither); `packages/sdk` with addresses and ABIs.
2. **Mocks.** Mock Stock Token with ERC-8056 multiplier, mock Chainlink feed with `updatedAt` control, mock USDG, mock DEX/aggregator.
3. **`StockWrapper`.** LM-R1…R7, invariant tests.
3b. **`StockWrapper` changes (D10 R1–R4).** `backingShortfall()` (LM-R8), `adminBurn` failure-mode test, optional `BlocklistHolderAllowlist` (LM-R6), `IScaledUIAmount` comment.
3c. **Extend mocks (D10 R5).** `oraclePaused()`, per-token and global `paused()`, blocklist reverting `Blocked(addr)`, `adminBurn`; mock sequencer uptime feed; mock Uniswap v3 pool (`observe`).
4. **`MarketHours`.** OR-R10…R14 (feed sessions and event windows), plus `packages/sdk/scripts/genSessions.ts` and `packages/sdk/data/events.json`.
5. **`StocklineOracle` + `ReceiptCollateralOracle`.** OR-R1…R8, OR-R20…R23, OR-R30…R33. SDK `priceAt`, `bufferAt`, `liquidationPriceAt`, `healthFactorAt`, shared test vectors.
6. **`clUSDG`.** CL-R1…R7, Paxos-freeze fork test.
7. **Deploy scripts (Vault V2).** `DeployCore` + `DeployStock`: wrapper → oracle → market → Vault V2 + adapter → caps → fee → roles → timelocks (LM-R10, LM-R20, LM-R22, LM-R23); `addresses.json`; Vault V2 code-hash fork test; `docs/runbooks/list-stock.md`.
8. **`StocklineRouter`.** RT-R1…R7, all flows, fork tests, gas report.
9. **Allocator keeper.** LM-R30…R34 (Vault V2 `allocate`/`deallocate`), pre-earnings pull.
10. **Guard keeper.** OR-R31, OR-R32, OR-R6 (L2 gaps), issuer flags.
11. **Fallback liquidator.** `StocklineLiquidator` (Morpho callback, unwraps `clUSDG`) + bot.
12. **Full lifecycle fork test.** Lend → open short → Friday ramp-in → weekend hold → Monday gap → liquidation → lender withdraws whole; plus earnings event, 1e18 feed incident, issuer pause, `adminBurn`.

### Phase 1 status (2026-09-27)

All twelve tasks are built and committed, with fork tests on Robinhood Chain (public RPC, latest block). The exit
criterion ("03, 04, 05 acceptance criteria pass on fork") is met for every criterion that can be met before testnet,
except the `openShort` gas placeholder (≈ 650k measured vs 600k; open question in [12](12-open-questions.md)).

| Task | Status | Evidence |
|---|---|---|
| 0 · PRD decisions D1–D10 | Done | [12](12-open-questions.md#phase-0-decisions-applied-2026-09-27) |
| 1–3 · Scaffold, mocks, `StockWrapper` | Done (before Phase 0) | – |
| 3b · `backingShortfall`, blocklist adapter | Done | `contracts/test/StockWrapper`, `test/fork/phase1/BlocklistHolderAllowlist.fork.t.sol` |
| 3c · Live-parity mocks | Done | `test/fork/phase1/MockParity.fork.t.sol` |
| 4 · `MarketHours` + calendar generator | Done | `test/MarketHours`, `packages/sdk/test/calendar.test.ts` (all 1,923 observed rounds inside generated sessions) |
| 5 · Oracles + SDK math + vectors | Done | `test/oracle` (exact match on 36k vectors) |
| 6 · `clUSDG` | Done | `test/CollateralToken`, `test/fork/phase1/CollateralTokenFreeze.fork.t.sol` |
| 7 · Deploy scripts (Vault V2) | Done | `script/`, `test/fork/phase1/{Deploy,VaultV2CodeHash}.fork.t.sol`, `docs/runbooks/list-stock.md` |
| 8 · `StocklineRouter` | Done (gas placeholder open) | `test/router`, `test/fork/phase1/Router.fork.t.sol` |
| 9 · Allocator keeper | Done | `keepers/test/allocator.test.ts` |
| 10 · Guard keeper | Done | `keepers/test/guard.test.ts` |
| 11 · Fallback liquidator | Done | `test/liquidator`, `keepers/test/liquidator.test.ts` |
| 12 · Full lifecycle fork test | Done | `test/fork/phase1/Lifecycle.fork.t.sol` |

## Phase 2 task breakdown

1. Ponder indexer (SI-R1…R5) and reconciliation job.
2. API (SI-R10…R14), OpenAPI spec, typed SDK client.
3. `ShortInterestLens` (SI-R20…R21).
4. Web app screens ([06](06-web-app.md)) in order: Markets → Lend → Short → Portfolio → Short-interest dashboard → Alerts.
5. Alerts service (APP-R8).
6. Compliance signer and geo-block (CP-R1…R4).
7. Testnet deployment, faucet for mock stocks and USDG, tester program.

### Phase 2 status (2026-09-27)

All engineering tasks are built, tested and committed; the testnet deployment is dry-run on an anvil fork of 46630 and
**waits for the owner's go**. The exit criteria that need time or people (2 clean testnet weekends, 20 external
testers) are pending; the tooling for them is in place.

| Task | Status | Evidence |
|---|---|---|
| 0 · Baseline, dev stack, chain driver | Done; guard-keeper flake fixed (receipt polling) | `scripts/dev.sh`, `docker-compose.yml`, `packages/devnet` (seed week) |
| 1 · Indexer SI-R1…R5 | Done | `indexer/test/indexer.test.ts`: 0 reconciliation diffs, backfill 33 s, head lag p95 1 block |
| 2 · `ShortInterestLens` SI-R20…R21 | Done | `contracts/test/lens` (100% coverage), `test/fork/phase2/Lens.fork.t.sol` |
| 3 · API SI-R10…R14, OpenAPI, typed client | Done | `api/test/api.test.ts` (API = lens), `api/loadtest/results.md` |
| 4 · Compliance signer, geo-block CP-R1…R4 | Done (sanctions provider pending) | `compliance/test/compliance.test.ts` |
| 5 · Web app APP-R1…R11 | Done | `web/e2e/flows.spec.ts` (10), `web/lighthouse/results.md` (96 / 91) |
| 6 · Alerts APP-R8 | Done | `keepers/test/alerts.test.ts` (delivery ~0.5 s after the block) |
| 7 · Testnet readiness | Done up to the go | `DeployTestnet.s.sol`, faucet, feed mirror, `infra/`, `runbooks/testnet.md`, `runbooks/testnet-dry-run.md` |
| Exit · 06/07 acceptance | 5 of 7 met; 2 pending testnet (7-day reconcile, 20 testers) | [06](06-web-app.md), [07](07-short-interest.md) |
| Exit · 2 clean testnet weekends | Pending (go + 2 weekends) | weekend watch in `runbooks/testnet.md` |
| Exit · 20 external testers | Pending (owner recruits) | tester kit in `runbooks/testnet.md` |

## Definition of done (any requirement)

- Code merged with tests. Contracts need ≥ 95% line coverage and fuzz/invariant tests where specified.
- The requirement ID is referenced in the test name or PR.
- SDK updated if the math or addresses changed.
- Docs/runbook updated if behavior visible to operators changed.
