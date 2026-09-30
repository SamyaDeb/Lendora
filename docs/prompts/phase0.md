We're building Lendora, a stock lending layer for Robinhood Chain built on unmodified Morpho Blue and MetaMorpho.
This session runs **Phase 0: Validation** end to end. Phase 0 turns every [VERIFY] assumption in the PRD into a
verified fact (with evidence) or a documented "no" (with its consequence). It then produces a go/no-go memo.

## 1. Read first (in this order, before doing anything)

1. `docs/LITEPAPER.md`
2. `docs/prd/README.md`, then `00-overview.md`, `02-architecture.md`, `03-lending-markets.md`, `04-oracle.md`,
   `05-collateral-router.md`, `08-delta-neutral-vault.md`, `10-risk-compliance.md`, `11-milestones.md`
3. `docs/prd/12-open-questions.md`, the Phase 0 checklist. Read it closely, including the section
   "Phase 1 engineering assumptions (added during build)" (A1–A8) and "PRD issues found against public docs".
4. `grep -rn "VERIFY" docs contracts/src contracts/test packages` to collect every [VERIFY] marker in the repo.

## 2. Current state of the repo (don't redo this)

- Phase 1 tasks 1–3 are done and committed: the monorepo scaffold (pnpm workspace, Foundry in `contracts/`, CI with
  fmt/build/test/slither/sdk), mocks (`contracts/test/mocks/`: MockStockToken with ERC-8056, MockChainlinkAggregator,
  MockUSDG, MockSwapAggregator), and `contracts/src/StockWrapper.sol` (LM-R1…R7, unit + invariant tests).
- Submodules: morpho-blue `v1.0.0`, metamorpho-v1.1 `3b17547`, OpenZeppelin `v5.4.0`, forge-std `v1.9.7`.
  `contracts/test/utils/MorphoDeployer.sol` deploys Morpho Blue in tests.
- `packages/sdk` has `addresses.json` (empty; written only by deploy scripts, never by hand), wad math and wrapper math.
- `foundry.toml` assumes `evm_version = "cancun"` (A4).
- `forge test` passes 44 tests; `pnpm -r test` passes 4 tests. Run both at the start to confirm, and again at the end.
- Nothing onchain is deployed. There is no `.env` and no fork test yet.

## 3. What I need from you before fork work (ask me if missing, and keep doing the desk research while you wait)

- `ROBINHOOD_RPC_URL` (mainnet, **archive** access needed for historical Chainlink rounds and weekend data)
- `ROBINHOOD_TESTNET_RPC_URL` (if a testnet exists)
- Explorer API key, if the explorer has a Blockscout/Etherscan-style API

They go in a git-ignored `.env`. Add a committed `.env.example` with the variable names and no values.
Never print or commit secrets.

## 4. Hard rules

- **Evidence or it isn't verified.** Every fact gets one of: (a) an onchain proof: contract address, chain id, block
  number and the call or event; or (b) a source URL you actually opened, plus access date and a short quote. Anything
  else is labeled `UNVERIFIED` with what would verify it. Never fill a gap from memory. If a doc and the chain disagree,
  the chain wins and both are recorded.
- **Read-only.** Never send a transaction to mainnet or testnet, and never sign anything. All onchain checks are `eth_call`,
  log queries or Foundry fork tests (`vm.createSelectFork`). Deploying Lendora contracts *inside a fork* is fine.
- **No outreach.** Don't contact issuers, Morpho, Chainlink, venues or interviewees. Produce the kits and I'll run them.
- **No legal conclusions.** Produce questions for counsel, not opinions.
- **CI stays green.** Fork tests live in `contracts/test/fork/` and skip cleanly when `ROBINHOOD_RPC_URL` is unset
  (`vm.envOr` + `vm.skip(true)`). They run in a separate, manually triggered CI job, not the default one.
- **Don't change Phase 1 behavior silently.** If a verified fact breaks existing code (for example, the wrapper or the
  multiplier semantics), don't fix it in this session. Record it under "Required Phase 1 changes" in the decisions doc
  with the requirement ID, and tell me.
- **PRD edits:** apply *factual* corrections (addresses, decimals, confirmed behaviors) directly, each tagged
  `(verified Phase 0, <date>)`. For anything that changes a *design decision* (the five "PRD issues found" items, and
  MetaMorpho v1.1 vs Vaults V2), write options + a recommendation and **ask me before editing the PRD**.
- Commit after each workstream with a message like `docs(phase0): chain facts (WS-A)` and a passing test suite.
- If something is blocked (no RPC, no public source), mark it `BLOCKED: <reason, what's needed>` and move on. Don't stall the whole session.

## 5. Workstreams

Do them in order A → G. A and B are the critical path: a "no" on Stock Token transfers into contracts, or on Morpho
availability, is a potential project blocker. Surface it to me as soon as you find it.

### WS-A · Chain, protocol and asset facts (desk research + onchain reads)

Deliverable: `docs/phase0/01-chain-facts.md` plus machine-readable `packages/sdk/external-addresses.json`
(keyed by chain id; this is distinct from `addresses.json`, which is for our own deployments). Add a typed export from
the SDK and a test that the JSON parses and every address is checksummed.

For each item, record the value, the evidence and a status (`VERIFIED onchain`, `VERIFIED docs only`, `UNVERIFIED`, `NO`).

1. **Network:** chain id, RPC(s), explorer, EVM version supported (confirms/refutes A4; test a `cancun` opcode such as
   `MCOPY`/`TSTORE` in a fork), block time, finality/reorg depth (for SI-R3), whether it's an L2 and which stack,
   sequencer uptime feed address (for proposed OR-R6).
2. **Morpho:** Morpho Blue address and version; owner; enabled IRMs (is AdaptiveCurveIRM deployed, its address?);
   enabled LLTVs (need 77%, 62.5%, and **0** for the idle market, A5); `irm = address(0)` enabled? (A5); MetaMorpho
   v1.1 factory address; Morpho Vaults V2 factory, if present (A6); public allocator; bundler/adapters. Read enabled
   IRMs/LLTVs from `EnableIrm`/`EnableLltv` events, not docs alone.
3. **Stock Tokens (SPY, NVDA, AAPL at minimum; list all available):** address, decimals (A2), proxy/upgradeable?
   (implementation address, admin), owner/roles, and **every admin power**: pause, blocklist/allowlist, freeze, forced
   transfer, mint/burn roles (A3, LM-R6, CP-R5). ERC-8056: confirm `uiMultiplier()`, `newUIMultiplier()`,
   `effectiveAt()`. Decide A1 from verified source code: does `uiMultiplier()` return the *effective* value after
   `effectiveAt` without a poke? Find any historical `UIMultiplierUpdated` events. Record how cash dividends are handled
   (multiplier vs airdrop vs other).
4. **Chainlink:** the feed address for each Stock Token and for USDG/USD; decimals, heartbeat, deviation threshold, `description()`.
   Confirm or refute "feeds return price per token, already multiplier-adjusted" (PRD issue 1) by comparing
   feed price vs a reference share price × `uiMultiplier()` at a block after a multiplier change, if one exists.
   Confirm 24/5 update behavior (OR-R13), any market-status or pause flag and its interface (PRD issue 4).
5. **USDG:** address, decimals and EIP-2612 `permit` support (A7), issuer admin powers (blocklist!), USDG yield vaults
   that could back `clUSDG` (CL-R1): address, ERC-4626?, can share price decrease?
6. **DEXs and aggregators:** which pools hold Stock Token liquidity (address, fee tier, TVL); which aggregators support
   Robinhood Chain and are callable from a contract (A8, RT-R3).
7. **Perp venues** (for Phase 4): Lighter, Arcus and any others that list these stocks: listed symbols, weekend
   trading, funding history availability, whether a smart contract can hold a margin account.
8. **Liquidators:** evidence of Morpho liquidations on this chain (count of `Liquidate` events, distinct callers).

### WS-B · Fork validation tests (`contracts/test/fork/phase0/`)

Deliverable: passing (or deliberately failing-and-documented) fork tests, plus `docs/phase0/02-fork-validation.md`
with a table: test name → question answered → result → block number.

Pin each test to a specific recent block (record it). Tests:

1. `StockTokenTransfer.fork.t.sol`: a funded holder (use `deal` only if the token's storage layout supports it;
   otherwise impersonate a real holder) transfers each Stock Token to (a) an EOA, (b) a freshly deployed
   `StockWrapper`, (c) Morpho Blue via `supply`. Assert exact received amounts (A2, LM-R1). Then unwrap to an EOA.
2. `StockTokenAdmin.fork.t.sol`: impersonate the token admin (fork only) and exercise pause/blocklist on the wrapper
   address to document exactly what happens to wrapped balances and to Morpho if the issuer freezes a contract. This is
   a risk finding, not a pass/fail.
3. `Erc8056.fork.t.sol`: read multiplier fields. If an update is pending or historical, `vm.warp` past `effectiveAt`
   and assert `uiMultiplier()` changes without a poke (A1). Run `StockWrapper.multiplier()`/`underlyingEquivalent` on the real token.
4. `MorphoMarket.fork.t.sol`: using the real Morpho Blue deployment (or our own deployment on the fork if none exists,
   and say so), create a market with loan = wrapped real Stock Token, collateral = real USDG (plain, since `clUSDG`
   doesn't exist yet), a minimal test oracle, AdaptiveCurveIRM and LLTV 77%. Run supply → supplyCollateral → borrow →
   warp 30 days → price move → liquidate → unwrap. Also create the idle market (A5) and a MetaMorpho v1.1 vault over
   the wrapper with the idle market enabled.
5. `ChainlinkFeeds.fork.t.sol`: `latestRoundData()` for each feed. Assert decimals and description; log `updatedAt`
   ages. Check the sequencer uptime feed if one exists.
6. `UsdgPermit.fork.t.sol`: EIP-2612 permit works on real USDG (A7).
7. `EvmVersion.fork.t.sol`: a contract compiled for `cancun` using `TSTORE`/`MCOPY` deploys and runs on the fork (A4).

Add a CI job `fork-tests` (`workflow_dispatch` only) reading `ROBINHOOD_RPC_URL` from repo secrets.

### WS-C · Weekend and price data (`sim/`)

Deliverable: reproducible Python in `sim/phase0/` (uv or venv + `requirements.txt`, pinned), raw data cached under
`sim/data/` (git-ignored if > 5 MB; commit a small sample and the fetch script), report
`sim/reports/phase0-weekend-gaps.md` with charts saved as PNG next to it.

1. Pull all Chainlink rounds (`AnswerUpdated`/`getRoundData`) for each launch Stock Token feed since the feed was deployed.
2. Pull Stock Token DEX prices (pool swap events or `slot0`/TWAP) over the same window, including weekends.
3. Pull reference share prices (daily + intraday if available from a free source; state the source and its terms) for
   ≥ 5 years for σ_annual.
4. Compute and report per stock:
   - Feed update pattern: updates per hour by weekday/hour (ET). Confirm 24/5 and the exact weekend gap window.
   - Weekend premium: DEX price vs frozen feed price during closures. Distribution (p50/p90/p99/max) and the largest episodes with timestamps. Check the "~12%" litepaper claim.
   - Monday gap: first post-open feed price vs Friday's last price. Distribution and max.
   - Overnight gap (weeknights) under 24/5 feeds, to size `overnightMode`.
   - Realized σ_annual (1y, 3y, 5y) → the buffer table from `04-oracle.md` §3 recomputed with real σ.
   - Buffer adequacy: the share of historical weekends where `|Monday gap| > b_full` for z = 2.33, and what z would give 99% and 99.9% coverage.
   - DEX depth: USD size to move price 2% on weekdays vs weekends (from pool math or aggregator quotes at sampled blocks).
   - Liquidation profitability check: in the worst weekend-premium episodes, would a 7.4% liquidation incentive (LLTV 77%) cover buying the stock on the DEX? This informs the "DEX floor" decision.
5. A first-pass borrow-demand estimate: over the history, the notional an arbitrageur could have shorted during
   premium episodes > X% given observed depth. Show assumptions explicitly.

Every chart needs labeled axes with units and time in ET, and a data-source line.

### WS-D · Morpho oracle constraint and parameter sanity (analysis, no Phase 1 code)

Deliverable: section in `docs/phase0/04-prd-decisions.md`.

- Using WS-C results, check the Morpho constraint that the oracle price must not drop instantly by more than
  what LLTV·LIF allows (≈ 17% at 77% LLTV; verify the exact wording and number in Morpho's current docs, with a link).
  Confirm the ramp-in, the multiplier bound in OR-R3 and the observed Monday gaps stay inside it. If real Monday gaps can
  exceed it, say so plainly and propose options.
- Recheck the worked example numbers in `00-overview.md` with the verified LLTV and incentive.

### WS-E · PRD decisions pack

Deliverable: `docs/phase0/04-prd-decisions.md`. One entry per decision, each with: context, verified facts (linked to
WS-A/B/C evidence), options, recommendation, affected requirement IDs, and whether it needs my approval.

Must cover:
1. OR-R1 multiplier double-counting (PRD issue 1).
2. 24/5 feeds → `overnightMode` default (PRD issue 2).
3. Sequencer uptime check → new OR-R6 (PRD issue 3).
4. Oracle pause flag → guard input (PRD issue 4).
5. Morpho instant-drop constraint (PRD issue 5 / WS-D).
6. MetaMorpho v1.1 vs Morpho Vaults V2 (A6): what V2 changes for the idle market and the allocator keeper (LM-R21, LM-R30…R34), and which is deployed on this chain.
7. Each of A1–A8: resolved / changed / still open.
8. Every row of "Product decisions pending" in `12-open-questions.md` that Phase 0 data can inform (for example the DEX floor, per-address caps).
9. **Required Phase 1 changes:** code already written that the verified facts invalidate, if any.

After I approve decisions, you apply them to the PRD in a separate commit.

### WS-F · Market validation kit (for me to run)

Deliverable: `docs/phase0/05-interview-kit.md`.
- Borrower guide (perp makers, arb desks, active traders; 15 interviews): 12–15 questions, ≤ 30 min, covering current
  hedging, willingness to pay 3–15% APR, stocks, sizes, collateral preferences, weekend behavior, dealbreakers.
- Lender guide (10 interviews): target APY, understanding of manufactured dividends via the multiplier, withdrawal liquidity expectations.
- Perp venue/partner guide: interest in onchain hedge and in the short-interest API.
- A scoring rubric and a results template (table) so answers roll up into the go/no-go memo.
- An outreach tracker template (CSV) with columns only, no names.

### WS-G · Legal question pack and go/no-go memo

Deliverables:
- `docs/phase0/06-legal-questions.md`: questions for counsel per `10-risk-compliance.md` CP-R6 and `12-open-questions.md`
  "Legal", plus anything WS-A found (for example, issuer admin powers, USDG blocklist). Each question gets why it matters
  and which requirement it blocks.
- `docs/phase0/GO-NO-GO.md`: one page. Lead with the recommendation (Go / Go with changes / No-go). Then a table of the
  critical checks (Stock Tokens transferable into contracts; Morpho with required IRMs/LLTVs; Chainlink feeds adequate;
  USDG usable; DEX depth sufficient for liquidations; buffer adequacy; liquidator presence), each with status and an evidence
  link. Then open items with owners (me, legal, Morpho, issuer), and the updated launch parameter suggestions from WS-C.
  Human-dependent items (interviews, legal) are shown as pending, not assumed.

## 6. Finish

- Update `docs/prd/12-open-questions.md`: tick verified checklist items with a link to the evidence; leave the others open with their `BLOCKED`/`UNVERIFIED` reason.
- Add `docs/phase0/README.md` indexing all Phase 0 outputs.
- Run `forge fmt --check`, `forge build`, `forge test` (with and without `ROBINHOOD_RPC_URL`), `pnpm -r typecheck`, `pnpm -r test`, and report the results honestly.
- End with a short summary: the go/no-go recommendation, any blockers found, decisions waiting for my approval, and what I must do by hand (interviews, legal, outreach).
