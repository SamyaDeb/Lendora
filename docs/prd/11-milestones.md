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
5. **`LendoraOracle` + `ReceiptCollateralOracle`.** OR-R1…R8, OR-R20…R23, OR-R30…R33. SDK `priceAt`, `bufferAt`, `liquidationPriceAt`, `healthFactorAt`, shared test vectors.
6. **`clUSDG`.** CL-R1…R7, Paxos-freeze fork test.
7. **Deploy scripts (Vault V2).** `DeployCore` + `DeployStock`: wrapper → oracle → market → Vault V2 + adapter → caps → fee → roles → timelocks (LM-R10, LM-R20, LM-R22, LM-R23); `addresses.json`; Vault V2 code-hash fork test; `docs/runbooks/list-stock.md`.
8. **`LendoraRouter`.** RT-R1…R7, all flows, fork tests, gas report.
9. **Allocator keeper.** LM-R30…R34 (Vault V2 `allocate`/`deallocate`), pre-earnings pull.
10. **Guard keeper.** OR-R31, OR-R32, OR-R6 (L2 gaps), issuer flags.
11. **Fallback liquidator.** `LendoraLiquidator` (Morpho callback, unwraps `clUSDG`) + bot.
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
| 8 · `LendoraRouter` | Done (gas placeholder open) | `test/router`, `test/fork/phase1/Router.fork.t.sol` |
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
| 1 · HIGH unattested collateral via `addCollateral` | Fixed (RT-R8): rescue top-up only, reverts `NoDebtPosition` without debt; residual documented (05 §1) | `test_RT_R8_*`, `LendoraRouterUpgrade.t.sol`; deep invariants 3 × 1M; fork 22/22; e2e 10/10 — `c158b8e` |
| 2 · MEDIUM geo headers trusted without the proxy secret | Fixed (CP-R8): startup refuses without `PROXY_SECRET` off anvil; web proxy drops client geo; per-wallet rate limit | `compliance.test.ts` `CP_R8_*`, `web/test/complianceProxy.test.ts` — `62415dc` |
| 3 · MEDIUM no ops monitoring / paging | Done: `keepers/src/monitor` MON-R1…R14, pagers, weekend log `GET /weekends` | `keepers/test/monitor.test.ts` (18, real chain conditions) — `48ddfb3` |
| 4 · Runbooks for every P0/P1 | Done: 12 runbooks + mainnet launch; timelock calldata tool; 7 rehearsals on anvil through the real timelock | `docs/runbooks/`, `packages/devnet/test/runbooks.test.ts`, `packages/sdk/test/timelock.test.ts` — `8550ba0` |
| 5 · Phase 0 gaps | Done for engineering: weekday depth tooling + Sunday snapshot (caps unchanged; weekday run pending the clock); syrupUSDG deferred v1.1; sequencer feed confirmed absent; 12 checklist reconciled | `sim/phase0/dex_depth.py`, WS-C §6, 12 — `609e111` |
| 6 · Coverage and cleanups | Done: router branches 77% → 91.1%, StockWrapper 94.87% → 100% lines, liquidator branches 87.5% → 93.75% (100% lines with the fork suite); `node_modules.nosync/` ignored | `LendoraRouterBranches.t.sol` — `c938fc9` |
| 7 · Open decisions Q1–Q7 | Q1–Q4 applied (openShort 649k → 644k on a fork, ≤ 700k accepted); Q5–Q7 `[OWNER]` | 12 "Decisions (remediation)", `sim/event_timing` — `5a5a574` |
| 8 · Audit readiness | Done: scope/threat model/known issues, NatSpec on every external/public function (`forge doc` clean), mainnet launch checklist, Phase 3 breakdown | `docs/audit/`, `docs/audit/FREEZE` — `84bfc62` |
| MetaMorpho v1.1 submodule | **Kept, pending the owner's call** (only the scaffold smoke test uses it; removing it shrinks audit scope) | `contracts/lib/metamorpho-v1.1` |

Final run (2026-09-28): `forge fmt --check` clean; `forge test` 205 passed / 15 skipped (fork, no RPC); with the
public RPC the fork suites pass 39/40 — the one failure is `test/fork/phase0` pinned to a historical block, which needs
an archive RPC (Q7, pending); `FOUNDRY_PROFILE=deep` router invariants 3 × 1,000,000 calls pass; every `src/` file ≥
97.8% lines; slither 67 findings, none medium+; `pnpm -r typecheck` / `lint` clean, `pnpm -r test` 183 passed; Playwright
10/10; Lighthouse 96 / 91 (accessibility 100).

## Phase 3 task breakdown (audit, guarded mainnet, fees)

Starts once the remediation is merged and the owner confirms the audit freeze ([`docs/audit`](../audit/README.md)).
Ordered so each task unblocks the next. The engineering session plan is
[`docs/prompts/phase3-4-mainnet.md`](../prompts/phase3-4-mainnet.md); its status is below the list.

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

### Phase 3 status (engineering, 2026-09-28)

Every engineering item is done; nothing was deployed to mainnet and nothing was sent to testnet in Phase 3 (no
"go testnet"). What remains needs people, money or calendar time: see the mainnet-readiness checklist below.

| Session task | Status | Evidence |
|---|---|---|
| 0 · Uncommitted work (`LOW_GAS` pager, `dev-testnet.sh`, prompts) | Done | `efbbdc8` |
| 1 · `FeeSplitter` (FE-R1…R3) | Done: bps weights (sum 10,000), permissionless `distribute`, revert-all (A32), owner = 48h timelock | `test/fees/FeeSplitter*.t.sol` incl. invariants `invariant_FE_R2_*` — `c21307e` |
| 2 · Performance fee in the deploy (FE-R1) | Done: 10% to the splitter before the vault timelocks; turn-fees-on path for deployed vaults (`vaultCuratorOperation`) | `test_FE_R1_*`, fork `FeeAccrual.fork.t.sol` — `2df2caf` |
| 3 · `FeeConverter` + keeper (FE-R4) | Done: onchain 1% floor, feed session + guard clear, one converter per recipient (A33) | `test/fees/FeeConverter.t.sol`, fork `FeeConverter.fork.t.sol`, `keepers/test/feeConverter.test.ts` — `b139605` |
| 4 · Revenue: indexer, API, web (FE-R5) | Done: `/v1/protocol/revenue`, web lender yield net of fee, revenue panel | API acceptance "endpoint total = onchain fee transfers" — `4b9f779` |
| 5 · Monitor MON-R16…R20 | Done | `keepers/test/monitor.test.ts` 22/22 — `4d003cf` |
| 6 · Sanctions providers (Q5, CP-R3) | Done: Chainalysis + TRM adapters, fail closed, mainnet refuses deny-list / unknown provider / missing key | `compliance/test/sanctions.test.ts` (fake HTTP server) — `faacdec` |
| 7 · Mainnet deploy script + `VerifyRoles` | Done: MN-R1…R5; refuses 4663 without `I_HAVE_THE_OWNERS_GO=1`; never broadcast | `test/deploy/DeployMainnet.t.sol` 13/13 (anvil), `DeployMainnet.fork.t.sol` 2/2 on the public 4663 RPC — `79f5f88` |
| 8 · Parameter simulation (04 §5) | Done: [`mainnet-params.md`](../../sim/reports/mainnet-params.md), Q2 study [`event-timing.md`](../../sim/reports/event-timing.md) (keep release-on-round), weekday DEX depth run; evidence pre-filled in `risk-signoff.md`; **no parameter changed**, differences flagged | `sim/params/params.py` — `02ab883` |
| 9 · Offchain security pass | Done: OFF-1…OFF-17 fixed or triaged, each fixed item with a test | [`offchain-review.md`](../audit/offchain-review.md) — `4107766` |
| 10 · Audit round 2 package, bug bounty, fix workflow | Done: README §8 (270 nSLOC new `src/`, deploy changes, post-freeze diff = none), threat model §9, [`bug-bounty.md`](../audit/bug-bounty.md), [`fix-workflow.md`](../audit/fix-workflow.md), `FeeConverter` invariants | `bb9bbcf` |
| 11 · Testnet fees and drills | **Rehearsed on a fork of 46630** (no "go testnet"): fee turn-on through the 24h timelock, first distribution and conversion, all §0 drills, 8/8; testnet drills pending the go | [`fork-drills-46630.md`](../runbooks/fork-drills-46630.md) — `3482ccb` |

Phase 3 plan items (list above) against that: 1–2 (audits) ⏳ owner; 3–5 ✅ engineering; 6 ⏳ (0 of 2 weekends
accrued, testers not recruited); 7 rehearsed on fork, ⏳ testnet go; 8 ✅ script and checks, ⏳ owner's go and the §0
gates; 9 ✅ engineering, ⏳ on mainnet; 10 ⏳.

Final run (2026-09-28, Part A exit): `forge fmt --check` clean; `forge build --sizes`: router 24,092 bytes (484 under
EIP-170, unchanged), `FeeConverter` 7,391, `FeeSplitter` 3,435; `forge test` 251 passed / 18 skipped without an RPC;
with the public 4663 RPC the fork suites pass 43/44 — the one failure is `test/fork/phase0` pinned to a historical
block (archive RPC, Q7); `FOUNDRY_PROFILE=deep` invariants: router 3 × 1,000,000 calls, `FeeSplitter` 2 × 1M,
`FeeConverter` 4 × 1M, all pass; coverage (Foundry 1.5.1 drops the router, liquidator, fee and adapter files from a
non-IR coverage build, so they are measured with `--ir-minimum`): every `src/` file ≥ 95% lines — router 98.7%,
liquidator 97.8%, `FeeConverter` 98.7%, `FeeSplitter` 97.6%, oracle base 99.5%, `StockWrapper` 100% (94.9% under
`--ir-minimum`, where its two `return` lines are unmapped), the rest 100%; slither 77 findings, none medium+, no new
low in the fee contracts; `forge doc` clean; `pnpm -r typecheck` / `lint` clean; `pnpm -r test` 287 passed / 8 skipped
(opt-in fork drills; 8/8 when run); Playwright 15 passed / 4 skipped (vault flows waiting for Phase 4 contracts);
Lighthouse `/markets` 82, `/data` 83 (accessibility and best practices 100) — **below the 85 target**: the pages are
the Lendora redesign's (LCP ≈ 4.4 s); an A/B run without the new CSP scored 83 / 84, so the CSP is not the cause.
Open item for the web owner.

### Phase 4 status (engineering, 2026-09-29)

Session plan: [`docs/prompts/phase4-testnet-mainnet.md`](../prompts/phase4-testnet-mainnet.md). Nothing was sent to
mainnet or testnet (no "go testnet", no hosting OK); every Phase 4 cap is 0 in every deploy config.

| Session task | Status | Evidence |
|---|---|---|
| A1/A2 · Services on 4663 (MN-R6) | Done: `resolveDeployment` in every service; refuses 4663 until published | per-package network tests — `f2fa372` |
| A3 · G5 receipt market | Done: stage 1 with caps 0, timelocked listing, CL-R10 window; indexer/API/web behind a flag | `ReceiptMarket.t.sol` 11, fork on 4663 — `6451be8`, `734b7d8` |
| A4 · Fee converter idle-only | Done | `feeConverter.test.ts` — `109844c` |
| A5 · Lighthouse | Done: `/markets` 90, `/data` 89 | `1023b18` |
| 12 · Perp venue research | Done: Lighter contract-held accounts viable, 5 `[VERIFY]` items (A39–A41) | [`01-perp-venue.md`](../phase4/01-perp-venue.md) — `8d2f5c4` |
| 13 · Sim gate | **INSUFFICIENT DATA** (94 days of funding); findings DN-R12, DN-R13 (proposal), dynamic `LEND_RATIO`, 1.54% entry cost | [`phase4-dn-vault.md`](../../sim/reports/phase4-dn-vault.md), [sign-off sheet](../owner-actions/dn-vault-signoff.md) — `e3ff104` |
| 14 · Contracts | Done: vault, strategy, NAV oracle, mock venue; DN-R1…R14; coverage 95.3 / 97.5 / 100% | `test/vault/*` 49 + 4 invariants — `a7390d4` |
| 15 · Keepers | Done: rebalancer, NAV reporter + co-signer, MON-R21…R25 | `dnVault.test.ts`, `monitorDn.test.ts` — `3f86e5e` |
| 16 · Indexer, API, web | Done: `/v1/vault/*`, USDG Earn on the real vault | `api/test/vault.test.ts`, e2e `vault.spec.ts` 9/9 — `734b7d8` |
| 17 · Tests | Done: fork lifecycle + 4 stresses on 4663 (6/6); seeded keeper week on anvil (100% in band) | `DnVault.fork.t.sol`, `dnWeek.test.ts` — `5a8a8ae` |
| 18 · Audit package | Done: 1,022 nSLOC; NAV single-signer drift bound; OFF-18…22 | [`audit/phase4`](../audit/phase4/README.md), freeze `6dc13f3` |
| C · Testnet | **Rehearsed on a fork of 46630 only**: fees + DN vault deploy and flows, drills 9/9 (14 steps), live-drill runner (two passes); smoke on the local stack, all checks pass | [`fork-drills-46630.md`](../runbooks/fork-drills-46630.md), [`testnet-smoke.md`](../runbooks/testnet-smoke.md) — `4ed9a8e` |
| D · Mainnet launcher | Built and rehearsed (dry run on a local 4663 fork: VerifyRoles 111/111), **never run**; found and fixed a VerifyRoles launch blocker | `packages/launch`, [`mainnet-launch.md` §3](../runbooks/mainnet-launch.md#3-deploy-scriptsmainnet-launchsh-the-only-supported-path) — `e390233` |

Final run (2026-09-29): `forge fmt --check` clean; `forge build --sizes`: router 24,092 B (484 under EIP-170,
unchanged), `DeltaNeutralVault` 12,499, `StrategyManager` 15,008, `NavOracle` 10,033; `forge test` without an RPC
323 passed / 0 failed / 20 skipped; fork suites on the public 4663 RPC 50/51 (the failure is `test/fork/phase0` pinned
to a historical block: archive RPC, Q7); `FOUNDRY_PROFILE=deep` invariants: router 3 × 1M, `FeeSplitter` 2 × 1M,
`FeeConverter` 4 × 1M calls pass, DN vault 4 × 1M still running at the time of this commit (> 100 CPU-min; isolated calls; the default profile, 4 × 25,600 calls, passes); `forge coverage --ir-minimum`: every `src/` file ≥ 95% lines
except `StockWrapper` 94.9% (its two `return` lines are unmapped under IR; 100% without), DN vault 95.3%, strategy
98.0%, NAV oracle 100%; slither 126 (76 informational, 50 low), none medium+; `forge doc` clean; `pnpm -r typecheck` /
`lint` clean; tests: sdk 87, devnet 19 (+10 opt-in fork), launch 9 (+1 opt-in dry run), indexer 12, API 26, keepers 99
(one monitor test timed out while the deep invariants saturated the CPU; 22/22 on re-run), compliance 24, web 78;
Playwright 19/19 (incl. 4 on-chain USDG Earn flows); Lighthouse on the committed tree `/markets` **82** (below the 85
target; 90 at A5), `/data` 89 (measured with one core busy on the DN deep run; with other sessions' uncommitted
`globals.css`/`Hero.tsx` edits `/markets` drops to 54, CLS 0.211); 46630 fork drills 9/9, live-drill rehearsal 3/3;
launcher dry run on a local 4663 fork: VerifyRoles 111/111.

Phase 4 exit (08: sim gate, audit, 30-day run) is **not met**: the sim gate is INSUFFICIENT DATA and needs the risk
owner, the audit is not booked, and a 30-day run needs a verified venue adapter and a cap above 0.

### Mainnet-readiness checklist (gates of [`mainnet-launch.md`](../runbooks/mainnet-launch.md) §0 and what §1–§4 need)

✅ = engineering done, with evidence. ⏳ = needs a person, money or time (owner and next step). Nothing that needs
people, time or mainnet is marked ✅.

| Gate | State | Evidence / owner and next step |
|---|---|---|
| Two audits closed, findings fixed or accepted | ⏳ | Package ready (README §1–§8, threat model, round-2 scope, fix workflow). **Owner:** pick two firms from [`audit-rfq.md`](../owner-actions/audit-rfq.md), confirm the freeze tag, book the windows (~3 weeks each + 1 fix week) |
| Counsel opinions and terms of use / risk disclosure (CP-R6) | ⏳ | **Owner + counsel:** send the engagement in [`messages.md`](../owner-actions/messages.md#counsel-engagement); terms draft `compliance/terms/` |
| Sanctions provider live (Q5) | ✅ engineering / ⏳ contract | Adapters and mainnet refusals tested (task 6). **Owner:** sign Chainalysis or TRM, put `SANCTIONS_PROVIDER` + `SANCTIONS_API_KEY` in the secret store; for TRM confirm the chain name (A37) |
| Risk owner signs the sim report and the weekday depth run | ✅ engineering / ⏳ sign-off | Reports and pre-filled evidence (task 8). **Risk owner:** sign [`risk-signoff.md`](../owner-actions/risk-signoff.md); decide the flagged items (D8 full caps SPY/AAPL, NVDA per-address cap on weekday depth, z); rerun weekday depth on 2 more sessions |
| 2 clean testnet weekends + 20 external testers | ⏳ | 0 of 2 accrued ([`testnet-weekends.md`](../runbooks/testnet-weekends.md)); first eligible Oct 2–4. **Owner:** start the testnet services live (keys), post the recruitment message, create the feedback form |
| Runbooks drilled on testnet | ✅ fork rehearsal / ⏳ testnet | 9/9 on a 46630 fork incl. Phase 4 ([report](../runbooks/fork-drills-46630.md)); live runner `drive live-drills` rehearsed in two passes. **Owner:** say "go testnet" (deployer 0.00839 ETH on 2026-09-29, enough), then run `live-drills`, re-run after 24h, record in runbooks/README.md |
| Bug bounty live, payout sized to caps (Q14) | ✅ draft / ⏳ listing | [`bug-bounty.md`](../audit/bug-bounty.md) (Critical max $450k proposed). **Owner:** confirm payouts, budget in the treasury Safe, choose platform, publish after deploy |
| Multisigs on hardware wallets (owner 4-of-7, guardian 2-of-4, curator, treasury, `BackstopReserve`) | ⏳ | `DeployMainnet` refuses anything weaker (MN-R2). **Owner:** create the five Safes with independent signers |
| Treasury and `BackstopReserve` addresses (Q9) | ⏳ | Config fields, refused if zero/EOA/placeholder (MN-R1/R2). **Owner:** provide the two Safe addresses |
| KMS keys (allocator, guard keeper, fee keeper, liquidator, compliance signer) | ✅ code / ⏳ keys | Remote signer on every signing service (OFF-4), gas cap, timeouts. **Owner:** create KMS keys and the signing bridge; fund keepers |
| Mainnet deploy script and role verification | ✅ | `DeployMainnet`, `VerifyRoles`, fork rehearsal on 4663 (task 7); **one-command launcher** `scripts/mainnet-launch.sh`, dry run on a local 4663 fork (Part D). Broadcast only after every ⏳ above and the owner's go |
| Gates recorded in [`launch-gates.json`](../owner-actions/launch-gates.json) | ⏳ | The launcher refuses until each gate has a person, date and evidence. **Each gate owner** fills their entry |
| USDG Earn (Phase 4) on mainnet | ✅ caps 0 / ⏳ gate | Ships with no venue adapter and caps 0 (MN-R7). **Risk owner:** sim sign-off (INSUFFICIENT DATA), DN-R13 trigger; **eng lead + Lighter:** the 5 `[VERIFY]` items and a $10 canary |
| Paging / on-call (PagerDuty or Opsgenie) | ✅ code / ⏳ accounts | Monitor MON-R1…R20, pagers. **Owner:** create the account, routing key, on-call rotation; start the monitor **before** the first governance action |
| Archive RPC (Q7) | ⏳ | Pinned fork runs pending. **Owner:** pick a provider ([`accounts.md`](../owner-actions/accounts.md#archive-rpc)), set `ROBINHOOD_RPC_URL` |
| Hosting (Q15) | ⏳ | Railway configs in `infra/railway/`, pinned images (OFF-15). **Owner:** create the mainnet project and secrets |
| Borrower / lender interviews | ⏳ | Outreach drafts in [`messages.md`](../owner-actions/messages.md). **Owner:** run them |
| Brand (Q6) | ⏳ | Nothing renamed. **Owner:** decide the name |

## Definition of done (any requirement)

- Code merged with tests. Contracts need ≥ 95% line coverage and fuzz/invariant tests where specified.
- The requirement ID is referenced in the test name or PR.
- SDK updated if the math or addresses changed.
- Docs/runbook updated if behavior visible to operators changed.
