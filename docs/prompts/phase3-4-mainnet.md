We're building Lendora, a stock lending layer for Robinhood Chain (chain id 4663, testnet 46630) on unmodified
Morpho Blue and Morpho Vault V2. Phases 0–2 and the remediation are committed, the audit package is frozen at
`docs/audit/FREEZE`, and **Lendora is live on testnet 46630 since 2026-09-28** (`packages/sdk/addresses.json` →
`chains["46630"]`, smoke 13/13).

This session **builds everything engineering can build for Phase 3 (fees, audit support, guarded-mainnet
readiness) and Phase 4 (delta-neutral vault, including its simulation gate)**, and leaves the repo in a state where
the only things between it and a guarded mainnet launch are items that need people, money or calendar time (audits,
counsel, testnet weekends, testers, sign-offs, owner keys). It **does not deploy to mainnet**, and it does not build
Phase 5 (backstop pool) beyond the `BackstopReserve` address that FE-R3 needs.

Work in the order below. Each part ends with a commit and a green quality bar before the next starts. If the context
gets long, finish the current task, commit, and continue. Don't skip ahead.

## 1. Read first (in this order, before writing code)

1. `docs/prd/README.md`, `docs/prd/11-milestones.md` (all status tables, **Phase 3 task breakdown**),
   `docs/prd/12-open-questions.md` (D1–D10, A1–A28+, Q1–Q7, pending product/legal items)
2. Phase 3 scope: `docs/prd/09-backstop-fees.md` (§1 FE-R1…R5; §2 only for context), `docs/prd/10-risk-compliance.md`
   (launch parameters, risk register, MON-R1…R15, CP-R1…R8, audits), `docs/prd/03-lending-markets.md` (fees,
   timelocks, §4 allocator), `docs/prd/04-oracle.md` (§5 simulation deliverable, acceptance)
3. Phase 4 scope: `docs/prd/08-delta-neutral-vault.md` (DN-R1…R11, weekend behavior, **simulation gate**, open
   questions), `docs/phase0/01-chain-facts.md` §7 (perp venues)
4. Mainnet: `docs/runbooks/mainnet-launch.md`, `docs/runbooks/README.md` (drill table), `docs/runbooks/testnet.md`,
   `docs/audit/README.md`, `docs/audit/threat-model.md`, `docs/owner-actions/*` (what's waiting on the owner)
5. Code: `contracts/script/{LendoraDeploy.sol,DeployTestnet.s.sol,DeployFork.s.sol,ForkConfig.sol}`,
   `contracts/src/**`, `contracts/lib/vault-v2/src/VaultV2.sol` (**performance fee, fee recipient, timelocked
   setters: read the real function names, don't guess**), `keepers/src/{common,allocator,liquidator,monitor}/*`,
   `indexer/`, `api/`, `compliance/src/*`, `web/app/**`, `infra/**`, `sim/{README.md,phase0,event_timing}`,
   `packages/sdk/src/**`

Then run the baseline:

```sh
git status                                    # uncommitted: LOW_GAS pager test, dev-testnet.sh, scripts/lib, prompts
cd contracts && forge fmt --check && forge build --sizes && forge test
cd .. && pnpm -r typecheck && pnpm -r lint && pnpm -r test
```

Expected (2026-09-28, no `ROBINHOOD_RPC_URL`): Foundry **205 passed / 15 skipped**; TS **183+ passed** (plus the new
`keepers/test/pager.test.ts`); `LendoraRouter` runtime 24,092 bytes (484 under EIP-170). If the tree has
uncommitted work that belongs to the repo (monitor `LOW_GAS` pager change, `scripts/dev-testnet.sh`, `scripts/lib/`,
`docs/prompts/*`, `web/AGENTS.md`, `web/CLAUDE.md`), show me the diff and commit it as task 0 once I confirm. If
anything fails, stop and report before changing code.

## 2. Hard rules

- **Never broadcast to mainnet (4663).** Never broadcast to testnet (46630) unless I explicitly say "go testnet" in
  this session. Without it, every onchain step is rehearsed on an anvil fork of 46630 or 4663 instead.
- **Secrets:** never print, log, echo, write to a file, or commit a key, API key or secret; never read key files.
  Services get keys only through env vars. Don't create hosting projects, accounts, repos, or push, without asking.
- **Morpho Blue and Vault V2 stay unmodified.** New contracts only where a task says so.
- **Audit freeze:** `src/` files listed in `docs/audit/README.md` §1 are frozen at `docs/audit/FREEZE`. Don't change them
  unless a task needs it. Any change needs a reason, a failing-first test, and an entry in a new
  "Post-freeze diff" section of `docs/audit/README.md` (file, commit, why). New contracts (FeeSplitter,
  FeeConverter, Phase 4 vault) are **new scope**: Phase 3 contracts go to audit round 2 / delta review, Phase 4 gets
  its own package.
- **Router size:** 484 bytes of headroom. Nothing in this session should grow `LendoraRouter`; if something must,
  check `forge build --sizes` in the same commit.
- **One source of truth:** addresses, ABIs and safety math come from `@lendora/sdk`. After any ABI change, re-export
  (`packages/sdk/scripts/export-abis.mjs`), regenerate `api/openapi.json` / `packages/sdk/src/api/schema.ts` when
  touched, and update every caller.
- **Exits are never blocked** (CP-R4, APP-R2, APP-R4, DN-R1): repay, close, withdraw, unwrap, rescue top-ups, and
  vault withdrawal requests work without an attestation, with a guard tripped, and for a geo-blocked visitor. Every
  task that touches an entry or exit adds a test proving it.
- **Requirement IDs everywhere:** test names, comments at the implementing site, commit messages. New requirements
  get new IDs in the right PRD doc (`FE-R6…`, `MON-R16…`, `DN-R12…`, `MN-R1…` for mainnet-readiness items). Never
  renumber existing ones.
- **Quality bar per task:** `forge fmt --check`, `forge test`, slither with no medium+ (triage new lows in
  `slither.config.json` with a reason), `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`; contract line coverage
  ≥ 95% per `src/` file (new files included); invariant/fuzz tests where the PRD says so; NatSpec on every
  external/public function (`forge doc` clean).
- **Keeper standards** (every new service): reuse `keepers/src/common/{chain,config,health,loop,signer}`, dry run by
  default, `/health`, restart-safe, idempotent, remote-signer support, a `MON-R9` `KEEPER_DOWN` entry, a Railway
  config in `infra/railway/`, `.env.example` lines, and a start line in `scripts/dev.sh`.
- **Commit after each task** with the task ID, e.g. `feat(contracts): FeeSplitter FE-R2 FE-R3 (phase 3 task 1)`, with
  the attribution lines your environment requires.
- **Don't touch `client/`** (separate marketing page, untracked) and don't rename "Lendora" (Q6 pending).
- **Ask, don't guess.** New engineering assumptions go in `12-open-questions.md` as A29+. If a §3 decision is still
  `[OWNER]`, use the default, build it as configurable, and list it in the final summary.
- **Be honest about gates.** Don't mark any acceptance box `[x]` that needs time, people or mainnet. Write
  "engineering done; pending <what>, owner <who>".

## 3. Decisions for this session (owner fills in; defaults apply if left)

| # | Question | Default if not answered |
|---|---|---|
| Q5 | Sanctions provider | `[OWNER]`. Build **both** Chainalysis and TRM adapters behind one interface (task 6); the deny-list stays for 31337/46630; mainnet still refuses to start without a real provider |
| Q6 | Brand name | `[OWNER]`. Don't rename anything |
| Q7 | Archive RPC | `[OWNER]`. Pinned fork runs stay "pending RPC" |
| Q8 | Fee split (FE-R2) | 10% performance fee; `FeeSplitter` weights **5,000 bps `BackstopReserve` / 5,000 bps treasury** |
| Q9 | Treasury and `BackstopReserve` addresses | `[OWNER]`. Config fields; the mainnet deploy refuses `address(0)` or an EOA-looking placeholder |
| Q10 | Fee conversion (FE-R4) | Convert both shares to USDG through an onchain `FeeConverter` (keeper can only trigger, never receive funds); weekly or > $1k, market hours only, ≤ 1% slippage vs oracle, UniversalRouter only (Q4) |
| Q11 | Build Phase 4 before its sim gate passes? | **Yes, build and test, but ship nowhere with a non-zero cap** until the gate report passes and the risk owner signs it. Testnet deploy of the vault only on "go testnet" and with the mock perp venue |
| Q12 | Perp venue (08 open question) | Venue-agnostic `IPerpAdapter` + `MockPerpVenue` for tests; research Lighter (RH instance) first. If contract-held margin accounts can't be verified, record it as `[VERIFY]` and **don't** build an operator-custodied fallback without asking (it breaks DN-R10) |
| Q13 | MetaMorpho v1.1 submodule | Keep (owner's call pending); note the audit-scope saving in the summary |
| Q14 | Bug bounty | Immunefi-style scope doc; max payout proposed as 10% of funds at risk under launch caps, owner to confirm |
| Q15 | Mainnet hosting | Railway (existing `infra/railway/*`). Add mainnet env docs; don't create projects |

## 4. Part A · Phase 3: fees, audit support, mainnet readiness

### Task 1 · `FeeSplitter` (FE-R1…R3)

- New `contracts/src/fees/FeeSplitter.sol`: recipients and weights in bps (sum = 10,000, enforced on every change);
  permissionless `distribute(token)` splits the contract's full balance of any ERC-20 (rSTOCK shares, USDG) by
  weight, with the rounding dust going to a fixed recipient so the balance ends at 0; weights and recipients change
  only through the owner (48h timelock); events for every change and distribution; no upgradeability.
- FE-R3: the backstop share goes to `BackstopReserve` (a multisig address) until Phase 5.
- Tests: unit, fuzz (any weights, any balance → sum of transfers = balance, no recipient over its share by more than
  1 wei), **invariant "sum of weights = 10,000"**, reentrancy with a malicious token, zero-balance distribute,
  recipient that reverts (decide: skip-and-keep vs revert-all; recommend revert-all + document, test it).

### Task 2 · Wire the performance fee into deployment (FE-R1)

- Read the real Vault V2 API for performance fee and fee recipient (both timelocked curator actions) and add them to
  `LendoraDeploy.sol`: deploy `FeeSplitter` in `_deployCore`, set `feeRecipient = FeeSplitter` and `fee = 10%` per
  `rSTOCK` vault in `_deployStock` **before** `increaseTimelock` locks it. Add the step to `docs/runbooks/list-stock.md`.
- A "turn fees on later" path for already-deployed vaults (testnet): timelock calldata in
  `packages/sdk/scripts/timelockCalldata.ts` (schedule → wait → execute), with a devnet rehearsal test.
- Fork test (09 acceptance): 30 days of accrual on a live-bytecode Vault V2 → fee shares minted to the splitter →
  `distribute` → amounts match `fee × interest` within rounding. Add it to `test/fork/phase3/`.

### Task 3 · `FeeConverter` contract + keeper (FE-R4)

- `contracts/src/fees/FeeConverter.sol`: holds the shares a recipient chose to convert; `convert(vault, shares,
  minUsdgOut, swapData)` callable only by the keeper role, **only during market hours** (`MarketHours`), only when the
  stock oracle's `guardReasons() == 0`; redeems `rSTOCK` → unwraps `wSTOCK` → swaps the Stock Token to USDG through the
  allowlisted UniversalRouter (same `SwapMode.Transfer` pattern as the router/liquidator) → enforces
  `minUsdgOut ≥ oracle value × (1 − 1%)` **onchain** → forwards USDG to the configured destination. The keeper can
  never set the destination or receive funds.
- Keeper `keepers/src/feeConverter/`: runs weekly or when the convertible balance > $1k (SDK pricing), builds swap
  calldata, respects market hours, dry run by default; `FEE_CONVERTER` in `MONITOR_KEEPERS`.
- Tests: unit (slippage bound, hours, guard, role), fork test with the real UniversalRouter and pools, keeper test on
  anvil through the devnet chain driver.

### Task 4 · Revenue: indexer, API, web (FE-R5)

- Indexer: fee shares minted per vault per day (from Vault V2 events), splitter distributions, conversions (USD at
  the oracle price at the block).
- API: `GET /v1/protocol/revenue` (per market per day, totals, currency both stock units and USD), OpenAPI and typed
  client updated. Acceptance test: **endpoint total = sum of onchain fee transfers** in a devnet run (09 acceptance).
- Web: lender yield shown in stock units and USD (09 §1 note); a small protocol revenue section on the short-interest
  dashboard. CP-R7 wording (variable, historical/current).

### Task 5 · Monitor additions for mainnet (Phase 3 task 5)

New rules in `keepers/src/monitor/` with IDs `MON-R16…` in `10-risk-compliance.md` and a runbook row each:

| Rule | Condition | Sev |
|---|---|---|
| `TIMELOCK_SCHEDULED` | Any `CallScheduled` on a Lendora timelock; decode the call (SDK) into the page | P1 |
| `TIMELOCK_EXECUTED` | Any `CallExecuted`; P0 if it wasn't scheduled through the tracked path | P1 |
| `ROLE_CHANGED` | Ownership, guardian, keeper, allocator, sentinel, curator or attestation-signer change on any contract | P0 |
| `LIQUIDATION_UNPROFITABLE` | Liquidatable position where the best DEX route at the current size loses money after LIF (missed-liquidation runbook) | P1 |
| `FEE_NOT_DISTRIBUTED` | Splitter or converter balance > $1k for > 8 days | P2 |

Each rule fires once and resolves once on anvil from real chain conditions (extend `monitor.test.ts`).

### Task 6 · Sanctions providers (Q5, CP-R3)

- `compliance/src/sanctions/{chainalysis,trm}.ts` behind the existing sanctions interface, selected by
  `SANCTIONS_PROVIDER`, keys from `SANCTIONS_API_KEY`. Build from each provider's public API docs; tests use recorded
  fixtures / a fake HTTP server (**no real API calls**). Timeouts and failures must fail **closed** for entries
  (no attestation) and never affect exits.
- Mainnet start: refuses the deny-list (already, CP-R8), refuses a missing key, logs the provider at startup.
- Update `docs/owner-actions/accounts.md` with the exact env vars.

### Task 7 · Mainnet deploy script and role verification (mainnet-launch §1–§3)

- `contracts/script/DeployMainnet.s.sol` + `MainnetConfig.sol`: no mocks, real addresses (Morpho Blue, Vault V2
  factories, Stock Tokens, USDG, Chainlink feeds, UniversalRouter), **every `LENDORA_*` role a distinct address**
  (A27 must not carry over), 48h timelocks, caps at **25% of the D8 targets**, per-address and global caps, oracle
  params from 10, event buffers, `sequencerFeed = address(0)`, `forceDeallocatePenalty = 0`, fee → `FeeSplitter`.
  The script **refuses to run** if any role address is zero, equals another role, equals the deployer, or if the
  chain id is 4663 without `I_HAVE_THE_OWNERS_GO=1`.
- `contracts/script/VerifyRoles.s.sol` (read-only): every check in mainnet-launch §3.4 plus the Vault V2 code hash;
  prints a pass/fail table the launch log can paste.
- Fork tests `test/fork/phase3/DeployMainnet.fork.t.sol`: deploy the exact mainnet config on a fork of 4663 `latest`
  with placeholder multisigs (Safe-like contracts), run `VerifyRoles`, then run the Phase 1 lifecycle flows against it.
- Update `mainnet-launch.md` with the exact commands.

### Task 8 · Parameter simulation for mainnet (04 §5; risk sign-off inputs)

The risk owner can't sign `docs/owner-actions/risk-signoff.md` until these exist.

- `sim/params/`: the 04 §5 deliverable. Per stock: σ_annual, z, ramp windows, event buffers, LLTV check, and **cap
  size such that 99.9% of simulated weekend gaps cause $0 bad debt** given LIF and measured DEX depth. Inputs are the
  existing `sim/data` (10y gaps, feeds, DEX depth). Report `sim/reports/mainnet-params.md` with a table that maps
  1:1 to the 10 launch-parameter table and flags every difference.
- Run the Q2 event-timing study (`sim/event_timing/compare.py`) to completion and write its conclusion (keep
  release-on-round or propose anchored). **Don't change the oracle**; if anchored wins, write it up as a proposal
  with its cost (new oracle → new markets).
- Weekday DEX depth: if the clock is in US regular hours, run `dex_depth.py --label weekday --markdown` and append to
  WS-C §6; otherwise leave the exact command and the next slot. Flag any difference > ±25% to me before touching caps.
- Pre-fill the evidence column of `risk-signoff.md` (links); leave the sign-off column empty.

### Task 9 · Offchain security pass (audit README "offchain has its own review item")

Keepers, indexer, API, web, compliance. Produce `docs/audit/offchain-review.md` and fix what you find, each with a
test:
- Secrets and signers: no key in logs/errors/health output; remote signer path works for every signing service;
  env validation at startup (zod) with clear errors.
- Inputs: API query/params validation, rate limits, CORS (`ALLOWED_ORIGINS`), WebSocket limits, SQL built only with
  parameters, no SSRF in any fetch with user input.
- Web: CSP and security headers, no secrets in client bundles (`NEXT_PUBLIC_*` audit), wallet-signing prompts show
  what is signed, revert decoder covers every custom error (including the new fee/vault ones).
- Supply chain: `pnpm audit --prod`, lockfile check, pinned Docker base images, non-root containers.
- Keepers: nonce management under restarts, gas price caps, idempotency on replays; liquidator can't be drained by
  crafted swap data.

### Task 10 · Audit round 2 package, bug bounty, fix workflow

- `docs/audit/README.md`: "Round 2 / delta scope" section: `FeeSplitter`, `FeeConverter`, deploy changes, and the
  post-freeze diff; nSLOC; new invariants and their tests; new known issues.
- `docs/audit/threat-model.md`: add fee-path attackers (swap data, sandwiching the converter, weight changes).
- `docs/audit/bug-bounty.md` (Q14): scope (contracts + addresses once deployed), out of scope, severity table, payout
  proposal sized to the launch caps, disclosure process.
- `docs/audit/fix-workflow.md`: finding ID → branch → failing-first test → fix → commit message format → re-review
  diff → status table template (`docs/audit/findings.md`, empty).

### Task 11 · Testnet: fees and runbook drills (Phase 3 tasks 6–7)

- **Without "go testnet":** rehearse everything on an anvil fork of 46630. Turning fees on through the 24h testnet
  timelock, first distribution and conversion, and each drill below. Record "rehearsed on fork" in
  `docs/runbooks/README.md`.
- **With "go testnet":** check the deployer's gas first (it was ~0.0084 ETH; see the bridge notes in
  `docs/prompts/testnet-e2e-testing.md`) and stop to ask if it's not enough. Then deploy `FeeSplitter` +
  `FeeConverter`, schedule the fee change, and run the drills on testnet: guard-tripped, oracle re-anchor
  (`resetReferences`), calendar-push, multiplier-change, keeper-down, and one P0 tabletop (bad-debt or wrapper
  shortfall). Record date, tx hashes and who ran each one.
- The 2 clean weekends and 20 testers can't happen in this session. Make sure `GET /weekends` and the tester kit are
  current and say in the summary what's accrued so far.

**Part A exit:** commit; full quality bar; update the Phase 3 status table in `11-milestones.md` (task → status →
evidence), `12-open-questions.md`, 09 acceptance boxes (engineering parts only), README status table.

## 5. Part B · Phase 4: delta-neutral vault

The PRD gates the build on the simulation (08 "Simulation gate"). Do the research and sim first (tasks 12–13), then
build (14–18) under Q11: tested and audit-ready, but **no non-zero cap anywhere** until the gate passes and is signed.

### Task 12 · Perp venue research (08 open questions, Q12)

- For Lighter's Robinhood Chain instance (and Arcus if it has public docs): markets for SPY/NVDA/AAPL, depth, fees,
  funding mechanics and history API, weekend trading, margin/maintenance rules, liquidation, **whether a smart
  contract can own a margin account and restrict withdrawals to itself** (DN-R10), and how perp equity can be read
  (onchain vs signed API) for DN-R4. Use only public docs/APIs; no accounts.
- Write `docs/phase4/01-perp-venue.md` with evidence links, and an A-record per conclusion. Mark unknowns
  `[VERIFY]` with an owner.

### Task 13 · Simulation gate (08 §"Simulation gate")

- `sim/dn_vault/`: fetch ≥ 12 months of hourly funding (public API), perp/spot basis, and Lendora borrow
  utilization/APY proxies (Morpho stock-loan markets on 4663 or the Phase 0 data; state which), cached in `sim/data/`.
- Model the position structure exactly as 08 (`S`, `M`, `C`, `L = 3`, `c = 5%`, `LEND_RATIO`, sleeves) with swap and
  rebalance costs from measured DEX depth, the delta band (DN-R2), margin targets (2× open, 3× during closures), the
  weekend no-spot-trade rule, the funding kill switch (DN-R7), and the liquidity guard (DN-R8, which sets
  `LEND_RATIO` per sleeve).
- Output: net APY p5/p50/p95 after costs; max drawdown; the four stresses (+20% Monday gap, −100% APR funding for a
  week, 72h venue withdrawal halt, 48h `rSTOCK` utilization at 100%); **gate verdict** against the pass criteria
  (p5 APY > 0, drawdown < 2% except venue failure, venue-failure loss bounded by the margin share); recommended
  `L`, `c`, `LEND_RATIO` and sleeve weights. Report `sim/reports/phase4-dn-vault.md`, plus a sign-off sheet like
  `risk-signoff.md`.
- If data is missing (e.g. too little funding history), say so and give the verdict as "insufficient data"; don't
  fabricate or extrapolate silently.

### Task 14 · Vault contracts (DN-R1…R10)

In `contracts/src/vault/` (new audit scope), interfaces in `src/interfaces/`:
- `DeltaNeutralVault`: ERC-4626 over USDG; instant withdrawals up to the cash buffer, then an ERC-7540-style request
  queue settled within 72h or the next US open, whichever is later (DN-R1); per-sleeve and total caps via the
  curator timelock (DN-R6, **launch cap 0 in all deploy configs until the gate passes**); performance fee 10% over a
  high-water mark to `FeeSplitter`, no management fee (DN-R9); **never mints or burns on a stale NAV** (DN-R5).
- `StrategyManager`: sleeves, allowlisted DEX (UniversalRouter), venue and bands; the operator can trade only inside
  limits and can't send funds anywhere except the vault, the venue adapter and allowlisted swap targets (DN-R10).
- `IPerpAdapter` + `MockPerpVenue` (margin, funding accrual, maintenance, liquidation, withdrawal halt switch for the
  stress test). A live venue adapter only if task 12 confirms contract-held accounts; otherwise leave it as the
  documented `[VERIFY]` gap.
- `NavOracle`: NAV = USDG + spot at the Chainlink feed (multiplier-adjusted, no buffer) + `rSTOCK` value + perp
  equity from a signed report; a report that moves NAV > 1% vs the onchain estimate needs a second signer (DN-R4);
  max age 15 min when the market is closed (DN-R5).
- Tests: unit, fuzz, and **invariants**: share price never moves on deposit/withdraw beyond rounding; no mint/burn on
  stale NAV; operator can't extract value; the queue is FIFO and always settleable from assets; caps respected.
  Coverage ≥ 95% per file. Check sizes against EIP-170.

### Task 15 · Rebalancer keeper and NAV reporter (DN-R2, R3, R4, R7)

- `keepers/src/dnRebalancer/`: trades delta to 0 when the band is breached and at least once per US session; margin
  top-ups from buffer, then by redeeming `rSTOCK` and selling spot (DN-R3); weekend rules (no spot trades unless
  margin < 1.5×); funding kill switch (DN-R7).
- `keepers/src/navReporter/`: signs perp-equity reports; second-signer flow for > 1% moves.
- Monitor rules `MON-R2x`: `DN_DELTA_BREACH`, `DN_MARGIN_LOW`, `DN_NAV_STALE`, `DN_QUEUE_OVERDUE`,
  `DN_KILL_SWITCH`, with runbooks `docs/runbooks/dn-*.md`.

### Task 16 · Indexer, API, web (DN-R11)

- Indexer and API: NAV per share history, yield split (lending / funding / buffer), current delta, margin ratio,
  venue exposure, queue status (`/v1/vault/*`, OpenAPI + typed client).
- Web: vault page with deposit, instant and queued withdraw, request status and claim; dashboard for DN-R11; clear
  risk text (venue risk, async withdrawals, CP-R7 wording). Deposit is an **entry** (attestation + geo like borrow);
  withdraw requests and claims are **exits** (never gated). Playwright flows for each.

### Task 17 · Fork and lifecycle tests (08 acceptance)

`test/fork/phase4/`: deposit → build position → rebalance → instant withdraw → queued withdraw settled after a
weekend → funding kill switch unwinds a sleeve → perp margin top-up → each of the four sim stresses replayed against
the contracts with the mock venue. Devnet: a seeded vault week in `packages/devnet` and the rebalancer running on
anvil for a simulated week with delta in band ≥ 99% of ticks (the rehearsal of the 30-day run).

### Task 18 · Phase 4 audit package

`docs/audit/phase4/`: scope and nSLOC, architecture, roles and trust (operator, NAV signers, venue), invariants with
test links, known issues (venue trust, NAV signer trust, the `[VERIFY]` gaps from task 12), and a freeze commit.

**Part B exit:** commit; full quality bar; Phase 4 status table in `11-milestones.md`; 08 acceptance boxes
(engineering parts only; the sim sign-off, the 30-day run and the audit stay open).

## 6. Finish

- Update `11-milestones.md` (Phase 3 and Phase 4 status tables, mainnet readiness checklist), README status table,
  `12-open-questions.md` (A29+, Q5–Q15 status), every PRD doc whose requirements changed (09, 10, 08, 04 acceptance),
  `docs/runbooks/README.md` (new runbooks, drill table), `docs/owner-actions/README.md` (refresh the human-items table).
- Final run, reported honestly (skips and flakes included): `forge fmt --check`, `forge build --sizes`, `forge test`
  (with and without `ROBINHOOD_RPC_URL`), `FOUNDRY_PROFILE=deep` invariants (router + new vault/splitter), `forge
  coverage` per-file table for `src/`, slither, `forge doc`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`,
  Playwright, Lighthouse.
- End with a short summary:
  1. Each task → status → evidence (test names, reports, commits).
  2. Sim verdicts: mainnet parameters (differences from 10) and the Phase 4 gate (pass / fail / insufficient data).
  3. New contract scope and nSLOC for audit round 2 and the Phase 4 audit; the post-freeze diff.
  4. Decisions still `[OWNER]`.
  5. **The mainnet-readiness checklist**: every gate in `mainnet-launch.md` §0 with ✅ (engineering done, with
     evidence) or ⏳ (needs a person/time: name the owner and the next concrete step). At minimum the ⏳ list will
     include: two audits (select, schedule, fix windows), counsel opinions + terms (CP-R6), sanctions provider
     contract (Q5), risk-owner sign-off on both sim reports, 2 clean testnet weekends + 20 testers, testnet drills (if
     no "go testnet"), multisig signers and hardware wallets, KMS keys, treasury/`BackstopReserve` addresses (Q9),
     bug bounty listing, paging/on-call accounts, archive RPC (Q7), interviews, brand (Q6), and for Phase 4 the perp
     venue confirmation, the 30-day run, and the separate audit.
