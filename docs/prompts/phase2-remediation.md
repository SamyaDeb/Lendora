We're building Stockline, a stock lending layer for Robinhood Chain (chain id 4663, testnet 46630) built on unmodified
Morpho Blue and Morpho Vault V2. Phase 0 (validation), Phase 1 (lending core) and Phase 2 (indexer, API, web app,
alerts, compliance, testnet readiness) are committed. A senior review on 2026-09-27 found one high-severity contract
bug, several gaps and open decisions. This session **fixes every Phase 0–2 finding and gap that engineering can close,
and leaves the repo audit-ready for Phase 3** (audits, guarded mainnet, fees). It does not start Phase 3 features.

## 1. Read first (in this order, before writing code)

1. `docs/prd/README.md`, `docs/prd/11-milestones.md` (Phase 1 and 2 status tables), `docs/prd/12-open-questions.md`
   (D1–D10, A1–A28, open questions from Phases 1 and 2)
2. `docs/prd/05-collateral-router.md` (§1 "Why gated collateral", CL-R*, RT-R1…R7), `docs/prd/10-risk-compliance.md`
   (monitoring and paging table, CP-R1…R7), `docs/prd/03-lending-markets.md` (LM-R8, §4 allocator),
   `docs/prd/04-oracle.md` (guards)
3. Code: `contracts/src/StocklineRouter.sol`, `contracts/src/interfaces/IStocklineRouter.sol`,
   `contracts/src/CollateralToken.sol`, `contracts/test/router/StocklineRouter.t.sol`,
   `contracts/test/router/StocklineRouter.invariant.t.sol`, `contracts/test/utils/LocalStockline.sol`,
   `compliance/src/{server,app,service,checks}.ts`, `keepers/src/common/*`, `keepers/src/alerts/*`,
   `infra/README.md`, `infra/railway/*.json`, `docs/runbooks/*`
4. Every caller of the router ABI: `grep -rn "addCollateral" --exclude-dir=node_modules --exclude-dir=out --exclude-dir=cache .`
   (SDK ABIs, web app, `packages/devnet` chain driver, keepers, tests)

Then run the baseline and confirm it:

```sh
cd contracts && forge fmt --check && forge build && forge test
cd .. && pnpm -r typecheck && pnpm -r lint && pnpm -r test
```

Expected (2026-09-27, without `ROBINHOOD_RPC_URL`, fork suites skipped): **187 non-fork Foundry tests pass**; TS:
sdk 67, devnet 8, indexer 10, api 13, keepers 28, compliance 8, web 11 (**145**), all passing. Contract line
coverage per `src/` file is 95–100% except `StockWrapper.sol` 94.87%; `StocklineRouter.sol` branch coverage 77%.
If anything differs, stop and report before changing code.

## 2. Hard rules (unchanged from Phase 2, plus remediation rules)

- **Never broadcast to mainnet (4663). Never broadcast to testnet (46630) in this session** unless I explicitly say go.
  Never commit keys or secrets. Don't create hosting projects, GitHub repos or push anywhere without asking me.
- **Morpho Blue and Vault V2 stay unmodified.** Contract changes are allowed only where a task below says so, each with
  a reason, a failing-first test (write the test that reproduces the bug, see it fail, then fix) and a note in the
  task summary. Keep storage layout of the UUPS router compatible (ERC-7201 namespace; append only).
- **One source of truth:** addresses, ABIs and safety math come from `@stockline/sdk`. After any contract ABI change,
  re-export ABIs to the SDK (`packages/sdk/scripts/export-abis.mjs`), regenerate `api/openapi.json` /
  `packages/sdk/src/api/schema.ts` if touched, and update every caller.
- **Exits are never blocked** (CP-R4, APP-R2, APP-R4): repay, close, withdraw, unwrap and rescue collateral top-ups must
  keep working without an attestation, with the guard tripped and for a geo-blocked visitor. Every task that touches
  entry checks adds an explicit test proving this.
- **Requirement IDs everywhere** (test names, comments at the implementing site, commit messages). New requirements
  get new IDs in the right PRD doc (e.g. `RT-R8`, `CP-R8`, `MON-R1…`); never renumber existing ones.
- **Quality bar per task:** `forge fmt --check`, `forge test`, slither with no medium+ (triage new lows in
  `slither.config.json` with a reason), `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test` all green; contract line
  coverage ≥ 95% per `src/` file.
- **Commit after each task** (`fix(contracts): gate addCollateral for new positions RT-R8 (remediation task 1)`) with
  the attribution lines your environment requires.
- **Don't touch `client/`** (separate "Lendora" marketing page, untracked, outside the workspace) except the
  `.gitignore` line in task 6.
- **Ask, don't guess.** Record new engineering assumptions in `12-open-questions.md` as A29+. If a decision in §3 is
  still marked `[OWNER]`, use the stated default, build it as configurable, and list it in the final summary.

## 3. Decisions for this session (owner fills in before starting; defaults apply if left)

| # | Question | Default if not answered |
|---|---|---|
| Q1 | OR-R3 quiet multiplier step | Keep `maxQuietMultiplierStep = 5%` (proposal approved); update OR-R3 text to remove "pending approval" |
| Q2 | OR-R14 event timing | Keep "release on first round at/after `endTs`" for launch; open a sim task to evaluate the anchored `P_eff ≥ P_pre-event·(1+b)` design before mainnet params |
| Q3 | `openShort` gas | Accept ≤ 700k; update the 05 acceptance criterion. Do the cheap wins from task 7 anyway |
| Q4 | Aggregators beyond Uniswap UniversalRouter | UniversalRouter only at launch |
| Q5 | Sanctions provider (CP-R3) | `[OWNER]` Chainalysis or TRM. Until chosen: deny-list adapter; mainnet start refuses to run without a real provider |
| Q6 | Brand name (Stockline vs Lendora) | `[OWNER]`. Don't rename anything in code this session |
| Q7 | Archive RPC for pinned fork runs / weekday depth | `[OWNER]` provides `ROBINHOOD_RPC_URL`; without it, fork tasks are marked "pending RPC" |

## 4. Tasks (in order)

### Task 1 · HIGH: close the unattested-collateral bypass (`StocklineRouter.addCollateral`)

**Bug (verified with a PoC on 2026-09-27).** `addCollateral(stock, amount, onBehalf, deadline)` mints `clUSDG` and
supplies it to Morpho with no attestation (RT-R2), no guard check and no global-cap check (RT-R1). Because Morpho Blue
borrowing is permissionless, an address that was never attested (geo-blocked, sanctioned) can:

1. `router.addCollateral(nvda, 2_000_000e6, self, deadline)`
2. `morpho.borrow(marketParams, 1500e18, 0, self, self)` then `wrapper.unwrap(1500e18, self)`

The PoC borrowed ≈ $340k NVDA (per-address cap $250k) with `clUSDG` supply 2,000× the global cap, without any
attestation. This breaks the stated design in 05 §1 ("New collateral enters only through the router, which checks
guard state, caps and attestation"), CP-R3 and D8.

**Fix (contracts):**

- `addCollateral` stays attestation-free **only as a rescue top-up**: it reverts with a new error
  `NoDebtPosition(onBehalf)` unless `MORPHO.position(id, onBehalf).borrowShares > 0`. Rescue top-ups are exempt from
  the global cap and guard (risk-reducing, must never be blocked). Keep its signature unchanged so existing callers
  compile; `CollateralAdded` event unchanged.
- New collateral without debt has no router path: new entrants post collateral through `borrow`/`openShort`
  (`collateralIn`), which are already attested and cap-checked. If the web app has a "deposit collateral only" UI for
  users without debt, remove it or route it through `borrow` with a zero-borrow guard (`borrowAmount == 0` must then
  still pass attestation, guard, global cap; decide and test).
- Add a new requirement **RT-R8** in `05-collateral-router.md`: "`addCollateral` is a rescue top-up for positions with
  debt; it needs no attestation, guard or cap check. All other collateral enters through attested entries."
- Rewrite 05 §1 "soft gate" paragraph to state the **residual** precisely (Morpho is permissionless, so this cannot be
  closed onchain): (a) a borrower who was attested once can top up via rescue and borrow more directly on Morpho,
  beyond the per-address cap; (b) anyone holding `clUSDG` in Morpho with zero debt (e.g. after `repay` without
  withdrawing collateral) can borrow again directly without a fresh attestation. Hard limits remain the vault caps,
  idle reserve and allocator pulls (03 §4). Mitigation = detection (task 3: `DIRECT_BORROW` alert) and the router
  per-address cap applying to all router entries. Add the same residual to the risk table in `10-risk-compliance.md`
  and to the audit known-issues list (task 8).

**Tests (write the PoC first, see it pass against the old code, then make it the regression test):**

- `test_RT_R8_unattestedUserCannotCreateCollateral`: fresh address, no attestation → `addCollateral` reverts
  `NoDebtPosition`; `clUSDG.totalSupply()` unchanged.
- `test_RT_R8_rescueTopUpWorksWithoutAttestationGuardTrippedAndCapHit`: open a position, then trip the guard, set the
  global cap below supply, let the attestation expire → `addCollateral` for self and by a third party for the
  borrower both succeed.
- `test_RT_R8_residualDirectBorrowDocumented`: attested borrower, rescue top-up, direct `morpho.borrow` succeeds
  (documents the accepted residual; the assertion message references 05 §1).
- Update `test_RT_addCollateralForAnother` (it currently adds collateral for an address without debt) and the
  invariant handler `addCollateral` in `StocklineRouter.invariant.t.sol` (only call it for users with debt; keep
  RT-R5/CL-R6/LM-R7 invariants passing at the default profile and at `FOUNDRY_PROFILE=deep`).
- Upgrade test: deploy the old implementation behind the proxy, upgrade through the timelock to the new one, storage
  intact (owner, signer, markets, caps, swap modes).

**Off-chain follow-ups:** re-export ABIs; web `Portfolio`/`Borrow` UI: "Add collateral" only on positions with debt,
plain-language message for `NoDebtPosition` in the revert decoder (APP-R3); devnet chain driver and seed week updated;
Playwright flows updated and passing; router gas report refreshed.

### Task 2 · MEDIUM: compliance signer must not trust geo headers without the proxy secret

`compliance/src/server.ts` passes `PROXY_SECRET || undefined`; when unset, `app.ts` trusts `cf-ipcountry` /
`x-vercel-ip-country` / `x-forwarded-for` from any caller, so a direct request with `cf-ipcountry: DE` passes CP-R1.

- `startCompliance` throws at startup unless `PROXY_SECRET` is set (≥ 32 chars) for every network except `31337`.
  Same for `TRUST_PROXY=true` without a secret. `devDefaultCountry` stays 31337-only (already).
- The web proxy route (`web/app/api/compliance/[...path]/route.ts`) must strip any client-sent geo, `x-forwarded-for`
  and `x-stockline-proxy` headers before setting its own; verify and test.
- Mainnet-mode guard: if the network is 4663 (future), refuse to start with the deny-list sanctions adapter (Q5).
- Rate-limit `/attest` per IP and per wallet (check `attestRpm` covers both).
- Tests (`compliance/test/compliance.test.ts`): startup fails without secret on 46630; with secret, spoofed geo headers
  without `x-stockline-proxy` → `GEO_UNKNOWN`; through the web proxy route a spoofed `cf-ipcountry` from the client is
  ignored. New requirement **CP-R8** in `10-risk-compliance.md`.
- Update `infra/README.md`, `infra/railway/compliance.json` and `web.json` env docs, `docs/runbooks/testnet.md`.

### Task 3 · MEDIUM: ops monitoring and paging (10 "Monitoring and paging", LM-R8)

None of the P0/P1 operator alerts exist. APP-R8 alerts are user-facing only. The Phase 2 exit ("2 clean testnet
weekends") needs these to observe and log a weekend, so they come before the testnet go.

Build `keepers/src/monitor/` (same standards as other keepers: reuses `common/{chain,config,health,loop,signer}`,
`/health`, restart-safe, idempotent, dry-run-free since it only reads) with a `Pager` transport interface
(PagerDuty/Opsgenie via env, Telegram and webhook reuse `alerts/transports.ts`, fake transport in tests), dedupe by
`(rule, subject)` with re-notify interval, and resolve notifications. Rules, each with a requirement ID `MON-R1…`
added to `10-risk-compliance.md`:

| Rule | Condition | Sev |
|---|---|---|
| `BAD_DEBT` | Morpho `Liquidate` with `badDebtAssets > 0` on a Stockline market | P0 |
| `MISSED_LIQUIDATION` | Any position HF < 1.0 for > 2 blocks (SDK `healthFactorAt`, positions from indexer) | P0 |
| `BACKING_SHORTFALL` | `backingShortfall() > 0` on any `StockWrapper` (LM-R8), checked every block | P0 |
| `CLUSDG_BACKING` | USDG balance of `clUSDG` < `totalSupply` (CL-R6; Paxos freeze/wipe) | P0 |
| `ORACLE_STALE` | Open session and `now − max(updatedAt, sessionOpen) > heartbeat + 10 min` | P1 |
| `FEED_REJECTED` | `GuardChanged(SANITY or USDG_FEED, true)` | P1 |
| `GUARD_TRIPPED` | Any `GuardChanged(tripped=true)`; resolve on clear | P1 |
| `L2_GAP` | Consecutive block timestamps > N min apart (share the guard keeper's detector) | P1 |
| `KEEPER_DOWN` | Allocator/guard/liquidator/alerts `/health` failing or no allocator run for 5 min | P1 |
| `DIRECT_BORROW` | Morpho `Borrow` on a Stockline market whose `caller` is not the router (task 1 residual) | P1 |
| `PULL_NOT_EFFECTIVE` | Guard tripped and vault free market liquidity > 0 after 2 blocks (LM-R31) | P1 |
| `UTILIZATION_HIGH` | > 95% for 1h | P2 |
| `CALENDAR_RUNWAY` | < 7 days of sessions stored, or an earnings date within 30 days not pushed | P2 |
| `INDEXER_LAG` | > 20 blocks, or reconciliation diff ≠ 0 (hook the SI-R5 stub into the pager) | P2 |

- A **weekend log**: every closure, write ramp-in start, full buffer, first fresh round, ramp-out and guard events per
  market to Postgres and expose `GET /weekends` (JSON) so the "2 clean testnet weekends" criterion is evidenced, not
  eyeballed. Link it from `runbooks/testnet.md` weekend watch.
- Tests on anvil with the devnet chain driver: each rule fires once and resolves once (simulate `adminBurn` on the
  mock, a stale feed, a bad-debt liquidation, a direct Morpho borrow, a killed keeper, a short calendar).
- `infra/railway/monitor.json`, Dockerfile entry, `.env.example`, `scripts/dev.sh` starts it.

### Task 4 · Runbooks for every P0/P1 (10: "Runbooks for each P0/P1 live in /docs/runbooks/")

Write `docs/runbooks/` pages, each with: trigger (alert rule), impact, first 5 minutes, decision tree, exact commands
(cast / keeper CLI / timelock calldata generator), who signs (guardian 2-of-4 vs owner timelock), comms template,
post-mortem checklist:
`bad-debt.md`, `missed-liquidation.md`, `wrapper-backing-shortfall.md` (issuer `adminBurn`), `usdg-freeze.md`,
`oracle-stale-or-rejected.md` (incl. `resetReferences` re-anchor, A13), `guard-tripped.md` (incl. manual trip/clear,
pull verification), `issuer-pause-or-blocklist.md` (A25), `sequencer-l2-gap.md`, `keeper-down.md`,
`direct-borrow.md`, `calendar-push.md` (sessions and earnings via timelock), `multiplier-change.md` (OR-R3 confirm).
Add a small `packages/sdk/scripts/timelockCalldata.ts` (or extend an existing script) that prints schedule/execute
calldata for the timelock actions the runbooks reference, with tests. Record which runbooks were rehearsed on anvil.

### Task 5 · Phase 0 technical gaps that engineering can close

- **Weekday DEX depth** (12 `[~]` DEX liquidity; GO-NO-GO "weekday check BLOCKED"): the public RPC serves `latest`,
  so an archive node isn't needed if `sim/phase0` `dex_depth.py` is run **on a weekday during US hours**. Add a
  `--label weekday` mode, run it when the clock allows (or document the exact command for the owner), append results
  to `sim/reports/phase0-weekend-gaps.md` §6 and update the cap/per-address-cap rationale in `10` if depth differs
  materially. Don't change caps without flagging it to me.
- **syrupUSDG rate** (12 `[~]` USDG): out of v1 scope (CL-R7 is v1.1). Mark it "deferred to v1.1" with the reason.
- **Sequencer uptime feed**: still absent on 4663; confirm `sequencerFeed = address(0)` in every deploy config and that
  the guard keeper's `L2_GAP` path is the active mitigation (test exists? link it; add if not).
- Reconcile the Phase 0 checklist in `12` so every item is `[x]`, `[~]` with an owner, or explicitly deferred.

### Task 6 · Low-severity cleanups

- `StockWrapper.sol` line coverage ≥ 95% (currently 94.87%); find the two uncovered lines with
  `forge coverage --report lcov` and test them.
- Raise `StocklineRouter.sol` branch coverage from 77% toward ≥ 90%: deadline/zero-amount/not-listed branches of each
  exit, `selfPermit` and `morphoAuthorizeWithSig` failure branches, `repay` by `type(uint256).max`, `withdrawLend`
  with idle ≥ needed, swap `Transfer` mode, `closeShort` with no debt.
- `StocklineLiquidator.sol` branches (87.5%): cover the remaining two.
- `.gitignore`: add `node_modules.nosync/` (the untracked `client/` has a 349 MB one that `node_modules/` doesn't
  match). Nothing else in `client/`.
- Remove stale wording: README "Phase 2 (not deployed)" rows stay accurate; the MetaMorpho submodule is kept only for
  the scaffold smoke test. Decide with me before removing it (audit scope benefits from removing unused deps).

### Task 7 · Open decisions from Phases 1–2 (apply §3 answers)

- Q1: update OR-R3 text; no code change if 5% is kept (`maxQuietMultiplierStepWad` already configurable).
- Q2: add a sim task stub in `sim/` (README + script skeleton) comparing release-on-round vs anchored event buffer
  on the 10y earnings gap dataset; leave the contract unchanged.
- Q3: try the cheap `openShort` gas wins without changing behavior: read `guardReasons()` once and reuse the stock
  answer / calendar reads between `_openChecks` and `_positionChecks` where the oracle interface allows it (add a
  combined view on the oracle only if it doesn't change OR-R* semantics, with tests). Re-measure on fork if
  `ROBINHOOD_RPC_URL` is set; update the 05 acceptance line to the accepted bound.
- Q4/Q5/Q6/Q7: record the answers (or `[OWNER]` pending) in `12-open-questions.md`.

### Task 8 · Phase 3 audit readiness (documents and freeze, no new features)

- `docs/audit/README.md`: scope (files + nSLOC per contract, commit hash to freeze), out of scope (Morpho Blue, Vault
  V2, OpenZeppelin, mocks, scripts except deploy), architecture diagram (from 02), roles and trust assumptions
  (timelock, guardian, allocator, keeper, compliance signer, issuer powers, Paxos), external integrations (Chainlink,
  UniversalRouter A15), the invariant list with test links (CL-R6, LM-R7, RT-R5, OR-R8, RT-R8), how to build and run
  every suite, and **known issues / accepted risks** (soft gate residual from task 1, A12 `forceDeallocatePenalty = 0`,
  A13 re-anchor, issuer `adminBurn`, Paxos freeze, no sequencer feed, OR-R14 timing, per-address cap softness).
- `docs/audit/threat-model.md`: attacker types (unattested user, malicious swap target data, oracle manipulation via
  thin pools, keeper compromise, compliance signer compromise, guardian compromise, issuer actions), each with the
  control and test that covers it.
- NatSpec complete on every external/public function in `contracts/src/` (`forge doc` builds without warnings).
- A deployment/role checklist for guarded mainnet (`docs/runbooks/mainnet-launch.md`): multisig 4-of-7 and 2-of-4
  setup, 48h timelock, role split (A27 testnet shortcut must not carry over), caps from D8, sanctions provider live,
  `PROXY_SECRET`, monitoring on, runbooks drilled.
- Draft a **Phase 3 task breakdown** in `11-milestones.md` (below the Phase 2 status): FeeSplitter + fee converter
  keeper (09 §1), audit rounds and fix windows, testnet weekends, runbook drills, mainnet deploy with caps, fees live.
  Don't implement them.

## 5. Finish

- Update `11-milestones.md` with a "Remediation (2026-…)" status table (task → status → evidence links), the README
  status table, `12-open-questions.md` (A29+, answered/pending decisions), and every PRD doc whose requirements changed
  (05 RT-R8 and §1, 10 CP-R8 and MON-R*, 04 OR-R3 wording).
- Final run and report honestly (including skipped/flaky): `forge fmt --check`, `forge build --sizes`, `forge test`
  (with and without `ROBINHOOD_RPC_URL`), `FOUNDRY_PROFILE=deep` router invariants, `forge coverage` (per-file table
  for `src/`), slither, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, Playwright e2e, Lighthouse.
- End with a short summary: each finding → fix → test name; coverage before/after; gas before/after; decisions still
  `[OWNER]`; and the **human items that gate Phase 3**, which this session cannot do:
  1. Create a private git remote and push so CI actually runs (the repo has no remote today; ask before pushing).
  2. Testnet go, `ROBINHOOD_TESTNET_RPC_URL`, deployer key or remote signer; then 2 clean weekends and 20 testers.
  3. 15 borrower + 10 lender interviews (Phase 0 kit) — the business case is unproven until then.
  4. Counsel opinions (06-legal-questions A–D) and terms sign-off (CP-R6).
  5. Sanctions provider contract and key (Q5); PagerDuty/Opsgenie, Resend, Telegram, WalletConnect accounts.
  6. Archive RPC (Q7); issuer, Chainlink, Morpho and liquidator-operator outreach (GO-NO-GO open items).
  7. Audit firm selection and scheduling; risk owner sign-off on the sim report (04 acceptance).
