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
| 7 · Testnet readiness | **Deployed on 46630 (2026-09-28)**; smoke 13/13 on testnet | `packages/sdk/addresses.json["46630"]`, `runbooks/testnet.md` |
| Exit · 06/07 acceptance | 5 of 7 met; 2 pending testnet (7-day reconcile, 20 testers) | [06](06-web-app.md), [07](07-short-interest.md) |
| Exit · 2 clean testnet weekends | Pending (services + 2 weekends from 2026-10-02) | weekend watch in `runbooks/testnet.md`, monitor `GET /weekends` |
| Exit · 20 external testers | Pending (owner recruits) | tester kit in `runbooks/testnet.md` |

### Remediation status (2026-09-27 → 2026-09-28)

A senior review on 2026-09-27 found one high-severity contract bug, several gaps and open decisions
([`docs/prompts/phase2-remediation.md`](../prompts/phase2-remediation.md)). All engineering items are done; the items
that need people, money or time are listed at the end.

| Task | Status | Evidence |
|---|---|---|
| 1 · HIGH unattested collateral via `addCollateral` | Fixed (RT-R8): rescue top-up only, reverts `NoDebtPosition` without debt; residual documented (05 §1) | `test_RT_R8_*`, `StocklineRouterUpgrade.t.sol`; deep invariants 3 × 1M; fork 22/22; e2e 10/10 — `c158b8e` |
| 2 · MEDIUM geo headers trusted without the proxy secret | Fixed (CP-R8): startup refuses without `PROXY_SECRET` off anvil; web proxy drops client geo; per-wallet rate limit | `compliance.test.ts` `CP_R8_*`, `web/test/complianceProxy.test.ts` — `62415dc` |
| 3 · MEDIUM no ops monitoring / paging | Done: `keepers/src/monitor` MON-R1…R14, pagers, weekend log `GET /weekends` | `keepers/test/monitor.test.ts` (18, real chain conditions) — `48ddfb3` |
| 4 · Runbooks for every P0/P1 | Done: 12 runbooks + mainnet launch; timelock calldata tool; 7 rehearsals on anvil through the real timelock | `docs/runbooks/`, `packages/devnet/test/runbooks.test.ts`, `packages/sdk/test/timelock.test.ts` — `8550ba0` |
| 5 · Phase 0 gaps | Done for engineering: weekday depth tooling + Sunday snapshot (caps unchanged; weekday run pending the clock); syrupUSDG deferred v1.1; sequencer feed confirmed absent; 12 checklist reconciled | `sim/phase0/dex_depth.py`, WS-C §6, 12 — `609e111` |
| 6 · Coverage and cleanups | Done: router branches 77% → 91.1%, StockWrapper 94.87% → 100% lines, liquidator branches 87.5% → 93.75% (100% lines with the fork suite); `node_modules.nosync/` ignored | `StocklineRouterBranches.t.sol` — `c938fc9` |
| 7 · Open decisions Q1–Q7 | Q1–Q4 applied (openShort 649k → 644k on a fork, ≤ 700k accepted); Q5–Q7 `[OWNER]` | 12 "Decisions (remediation)", `sim/event_timing` — `5a5a574` |
| 8 · Audit readiness | Done: scope/threat model/known issues, NatSpec on every external/public function (`forge doc` clean), mainnet launch checklist, Phase 3 breakdown | `docs/audit/`, `docs/audit/FREEZE` — `84bfc62` |
| MetaMorpho v1.1 submodule | **Kept, pending the owner's call** (only the scaffold smoke test uses it; removing it shrinks audit scope) | `contracts/lib/metamorpho-v1.1` |

Final run (2026-09-28): `forge fmt --check` clean; `forge test` 205 passed / 15 skipped (fork, no RPC); with the
public RPC the fork suites pass 39/40 — the one failure is `test/fork/phase0` pinned to a historical block, which needs
an archive RPC (Q7, pending); `FOUNDRY_PROFILE=deep` router invariants 3 × 1,000,000 calls pass; every `src/` file ≥
97.8% lines; slither 67 findings, none medium+; `pnpm -r typecheck` / `lint` clean, `pnpm -r test` 183 passed; Playwright
10/10; Lighthouse 96 / 91 (accessibility 100).

## Phase 3 task breakdown (audit, guarded mainnet, fees) — draft, not started

Starts once the remediation is merged and the owner confirms the audit freeze ([`docs/audit`](../audit/README.md)).
Ordered so each task unblocks the next; nothing here is implemented yet.

1. **Audit freeze and package.** Tag `audit-r1-freeze` at the commit in `docs/audit/FREEZE`; send the package
   (scope, threat model, known issues) to both firms; set up a private repo remote and CI (human item).
2. **Audit round 1** (firm A, ~3 weeks) and **round 2** (firm B, ~3 weeks, overlapping or sequential), plus a formal
   review of the oracle math and buffer logic (OR-R1, OR-R20; 10 audits). **Fix windows:** 1 week after each report;
   every fix with a failing-first test and the finding ID in the commit; re-review of the diff from the freeze.
3. **`FeeSplitter`** (FE-R1…R3): recipients and weights in bps (lenders' share stays in the vault as the 10%
   performance fee split: backstop ~5% → `BackstopReserve` multisig until Phase 5, treasury ~5%); permissionless
   `distribute(token)`; weights via the owner timelock. Tests incl. invariant "sum of weights = 10,000", fork test with
   live Vault V2 fee accrual. Enters audit round 2 scope (or a delta review).
4. **Fee converter keeper** (FE-R4): swaps `rSTOCK`/`wSTOCK` fee shares to USDG weekly or above $1k, market hours only,
   ≤ 1% slippage via the allowlisted UniversalRouter; same keeper standards (dry run default, `/health`, monitor
   `KEEPER_DOWN`). Indexer + API revenue (FE-R5, `/v1/protocol/revenue`).
5. **Monitor additions for mainnet:** page on any timelock `CallScheduled` / `CallExecuted` and on role changes
   (threat model §7); bot-level "liquidation unprofitable" alert (missed-liquidation runbook).
6. **Testnet weekends and testers** (Phase 2 exit carried over): 2 clean weekends with `GET /weekends` evidence;
   20 external testers.
7. **Runbook drills on testnet**: guard-tripped, oracle re-anchor, calendar push, multiplier change, keeper-down, a
   P0 tabletop; record dates in `docs/runbooks/README.md`.
8. **Mainnet deploy with caps** ([`runbooks/mainnet-launch.md`](../runbooks/mainnet-launch.md)): multisigs 4-of-7 and
   2-of-4 on hardware wallets, 48h timelock, role split (no A27 shortcut), D8 caps at 25% of target, sanctions
   provider live (Q5), `PROXY_SECRET`, monitoring and on-call live, bug bounty live.
9. **Fees live** (09 §1 acceptance): performance fee to `FeeSplitter` through the vault timelock; first distribution
   and conversion observed; revenue visible in the API.
10. **Exit review:** 2 audits closed, runbooks drilled, mainnet running with caps, fees live (Phase 3 exit criteria).

## Definition of done (any requirement)

- Code merged with tests. Contracts need ≥ 95% line coverage and fuzz/invariant tests where specified.
- The requirement ID is referenced in the test name or PR.
- SDK updated if the math or addresses changed.
- Docs/runbook updated if behavior visible to operators changed.
