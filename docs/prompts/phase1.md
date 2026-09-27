We're building Stockline, a stock lending layer for Robinhood Chain (chain id 4663) built on unmodified Morpho Blue
and Morpho Vault V2. Phase 0 (validation) is complete. This session **finishes Phase 1: the lending core**. That means
applying the approved Phase 0 decisions to the PRD, then building every remaining Phase 1 contract, script and keeper
until the Phase 1 exit criteria pass on a fork.

## 1. Read first (in this order, before writing code)

1. `docs/LITEPAPER.md`, then `docs/prd/README.md`
2. `docs/phase0/GO-NO-GO.md`, then `docs/phase0/04-prd-decisions.md` (D1–D10, **the most important input**),
   `docs/phase0/01-chain-facts.md` (real addresses, interfaces, admin powers), `docs/phase0/02-fork-validation.md`,
   `sim/reports/phase0-weekend-gaps.md`
3. `docs/prd/02-architecture.md`, `03-lending-markets.md`, `04-oracle.md`, `05-collateral-router.md`,
   `10-risk-compliance.md`, `11-milestones.md`, `12-open-questions.md`
4. The existing code: `contracts/src/`, `contracts/test/` (incl. `test/fork/phase0/Phase0ForkBase.sol` for fork
   patterns), `packages/sdk/src/` (incl. `externalAddresses.ts` and `external-addresses.json`)

Then run `cd contracts && forge fmt --check && forge build && forge test` and `pnpm -r typecheck && pnpm -r test` and
confirm the baseline. Expected: 44 Foundry tests pass, 7 fork tests skipped without `ROBINHOOD_RPC_URL`, 8 SDK tests pass.

## 2. Current state (don't redo)

- Done: Phase 1 tasks 1–3 (scaffold, mocks, `StockWrapper` LM-R1…R7) and all of Phase 0 (chain facts, fork tests,
  weekend data, decisions pack, interview kit, legal questions, go/no-go = **Go with changes**).
- **Nothing in `04-prd-decisions.md` has been applied to the PRD yet.** Only factual corrections tagged
  `(verified Phase 0, …)` are in.
- Submodules: morpho-blue `v1.0.0`, metamorpho-v1.1 `3b17547` (now superseded, see D6), OpenZeppelin `v5.4.0`,
  forge-std `v1.9.7`.
- `.env.example` exists. `ROBINHOOD_RPC_URL` may or may not be in `.env`; the public RPC is not archive, so pinned-block
  fork runs may need `PHASE0_FORK_BLOCK=0` (latest). Ask me for an archive RPC if you need one; don't block on it.

## 3. Decisions I've approved (apply these; don't re-ask)

| # | Decision | What it means for Phase 1 |
|---|---|---|
| D1 | Oracle uses `P_wrapped = chainlink(STOCK/USD)` (the feed is already multiplier-adjusted). The multiplier is display + guard input only | Restate OR-R1, OR-R3, both §1 formulas, OR-R22, DN-R4 |
| D2 | `overnightMode` on, overnight buffer 0. `MarketHours` models **feed sessions** (Sun 20:00 → Fri 20:00 ET minus holidays). Ramp-in 4h before the Friday 20:00 ET freeze; ramp-out on the first fresh round | OR-R10, R11, R13, R20, R23; 10-risk ramp rows |
| D3 | New OR-R6: optional `sequencerUptimeFeed` (`address(0)` = disabled; if set, the guard trips while down + 1h grace) plus keeper-side L2 block-gap detection. `price()` never reverts | Oracle + guard keeper |
| D4 | The guard also trips on the token's `oraclePaused()`, `paused()` (token or global) and a blocked wrapper. New OR-R7 sanity band: a round outside ×0.5–×2 of the last good answer, or outside [$0.01, $1e6], is ignored (last good kept) and trips the guard | Oracle + guard keeper |
| D5 | Scheduled-event buffers: `MarketHours` also stores event windows (earnings) and the oracle ramps a buffer in before them (NVDA ≥ 10%, AAPL ≥ 8%, SPY none). The guard pulls liquidity before earnings for NVDA/AAPL. LLTV stays 77% | `MarketHours`, oracle, allocator |
| D6 | **Morpho Vault V2** via the official factory (from `external-addresses.json`) instead of MetaMorpho v1.1. No idle market; the idle reserve = vault's unallocated balance; utilization cap via relative caps; guard trip = `deallocate` free liquidity; Sentinel = our Guardian | LM-R20–R22, LM-R30–R34, 02 contracts/roles, 03 §3–4; A5 moot |
| D8 | DEX floor **off**. Launch caps: SPY $1M, NVDA $1M, **AAPL $250k**. Per-address caps: SPY $75k, NVDA $250k, AAPL $35k (allowlist for larger MMs). Launch params from GO-NO-GO (σ 17/52/28%, z 2.5). Drop or qualify the unsourced "~12% premiums" line in the litepaper and 00-overview | 10-risk launch table, 04 §3 table, OR-R… DEX floor note |
| D9 | **Keep** `StockWrapper`, with the D10 restatements | – |
| D10 | Apply R1 (LM-R7 restated + `backingShortfall()` view + P0 alert), R2 (LM-R5 restated), R3 (deploy with allowlist `address(0)`; optional blocklist-precheck adapter), R4 (cosmetic), R5 (extend mocks), R6 (add `vault-v2` submodule; keep the v1.1 smoke test only if it still builds cleanly, otherwise remove it and the submodule) | Code + PRD |

## 4. Hard rules

- **Never broadcast a transaction** to Robinhood Chain mainnet or testnet, never sign with a real key, and never commit
  keys. Deploy scripts run against anvil and forks only (`forge script` without `--broadcast`, or `--broadcast` against a
  local anvil fork). Keepers default to dry-run mode.
- **Morpho Blue and Vault V2 stay unmodified.** Pin `vault-v2` to the commit matching the onchain factory. Verify it:
  a fork test compares the runtime code hash of a vault deployed by our pinned source with a vault from the live factory,
  or explains any difference (immutables).
- **Requirement IDs everywhere:** in test names (`test_OR_R20_rampIn…`), NatSpec and commit messages.
- **One source of math.** Health factor, buffer, price and liquidation price live in `packages/sdk`. Solidity and SDK are
  cross-checked with shared **test vectors**: the SDK generates `contracts/test/vectors/*.json`, and forge reads them with
  `vm.readFile`/`vm.parseJson` (no `ffi`). At least 10k vectors for the buffer and price, covering DST weeks and holidays.
- **`price()` never reverts** on feed or guard conditions, and never drops more than Morpho's instant-drop bound
  (17.29% at LLTV 77%) in one block from anything we control (buffer changes, multiplier). Prove it with a fuzz/property test.
- **Fork tests** go in `contracts/test/fork/phase1/`, reuse the Phase 0 base pattern and skip cleanly without `ROBINHOOD_RPC_URL`.
- **Quality bar per task:** forge fmt, build, tests green; ≥ 95% line coverage on `src/` (`forge coverage`); no new
  slither findings at medium+ (triage false positives in `slither.config.json` with a comment); `pnpm -r typecheck` and
  `pnpm -r test` green.
- **Commit after each task** (`feat(contracts): StocklineOracle OR-R1…R7, R20…R23 (Phase 1 task 5)`) with the attribution
  lines your environment requires.
- **Ask, don't guess** if the PRD (after step 0) is ambiguous, contradicts a verified fact, or Vault V2's actual interface
  doesn't support a requirement as written. Propose the PRD edit and wait. Keep going on other tasks while you wait.
- Pending human items (interviews, legal, issuer, Chainlink sequencer feed, Morpho listing) **do not block** Phase 1.
  Don't try to resolve them.

## 5. Tasks (in order)

### Step 0 · Apply decisions to the PRD (one commit: `docs(prd): apply Phase 0 decisions D1–D10`)

- Rewrite the affected requirements listed in §3 in `02`, `03`, `04`, `05`, `08`, `10`, `11` and `12`. Keep IDs stable;
  add new ones (OR-R6, OR-R7, LM-R8 for `backingShortfall`, event-window IDs), and mark removed ones `(retired, D6)` rather
  than deleting them.
- `11-milestones.md`: update the Phase 1 task list to the one below.
- `12-open-questions.md`: mark D1–D10 as applied, with links.
- Show me a short diff summary in chat before moving on (don't wait for a reply unless something is ambiguous).

### Task 3b · StockWrapper changes (D10 R1–R4)

- `backingShortfall()` view (`totalSupply − underlying.balanceOf(this)`, floored at 0) + event-free monitoring hook. NatSpec
  explains `adminBurn`. Keep the LM-R7 invariant test (mocks); add a test with the extended mock's `adminBurn` that shows
  the failure mode and `backingShortfall() > 0`.
- Optional `BlocklistHolderAllowlist` adapter (`isAllowed(to) = !token.isBlocked(to)` or the real registry call from
  `01-chain-facts.md`). Test it on a fork.
- Fix the `IScaledUIAmount` comment (R4).

### Task 3c · Extend mocks (D10 R5)

`MockStockToken`: `oraclePaused()` + setter, per-token and global `paused()`, a blocklist that reverts `Blocked(addr)` on
transfer/approve like the live token, `adminBurn`. Match the live signatures and errors exactly as recorded in
`01-chain-facts.md`. Also add a mock sequencer uptime feed and mock Uniswap v3 pool/observe for TWAPs.

### Task 4 · `MarketHours` (OR-R10…R12 as restated)

- Stores feed sessions `{openTs, closeTs}` (UTC) **and** event windows `{stock, startTs, endTs, bufferWad}`.
- Views: `isOpen(t)`, `currentOrNextSession(t)`, `closureLength(t)`, `activeEvent(stock, t)`, `nextEvent(stock, t)`.
- Batch pushes via the owner (timelock is part of task 7's roles). Failsafe: past the last session = closed with
  `MAX_CLOSURE` (96h).
- `packages/sdk/scripts/genSessions.ts`: generates feed sessions from the NYSE holiday calendar (holidays = frozen like
  weekends, per Phase 0 data: e.g. 2026-07-03 had no rounds; Labor Day 2026-09-07 rounds only from 20:00 ET), with DST
  handled in TS, not Solidity. Also a typed earnings-calendar input file (`packages/sdk/data/events.json`) with a
  documented source. Test the generator against the observed 2026 feed pattern from `sim/`.

### Task 5 · `StocklineOracle` + `ReceiptCollateralOracle` (OR-R1…R7, R20…R23, R30…R33 as restated)

- Morpho `IOracle` with the D1 formula, `1e36` scaling and real decimals (feeds 8 dp, USDG 6 dp, Stock Tokens 18 dp).
- Buffer: `b_full = clamp(z·σ·sqrt(closureHours/8760), B_MIN, B_MAX)`, ramp-in over 4h before a closure or event
  window, hold, ramp-out only on the first round with `updatedAt ≥ open`. Event buffers are the max of weekend and event.
- Guards: staleness (with `poke()` permissionless), sanity band (OR-R7, keeps last good answer), `oraclePaused()`,
  token `paused()`, wrapper blocked, multiplier change outside an `oraclePaused` window or outside [0.1×, 10×], optional
  sequencer feed (OR-R6), manual trip/clear. `GuardChanged(reason, tripped)` events. `guardTripped()` view.
- Params in constructor; changes only via the owner (timelock in task 7); Guardian can only raise buffer or trip.
- Tests: every OR-R ID; replay of the **launch-week 1e18 incident** (answers ×10¹⁰) must not move `price()` and must trip
  the guard; replay of a 4:1 split with `oraclePaused` window must not move `price()`; DST weeks, Good Friday,
  Thanksgiving, 3-day weekends, missed Sunday round; the 17.29% instant-drop property; NVDA +26% earnings gap with the
  event buffer in force (show the resulting LTV path).
- SDK: `priceAt`, `bufferAt`, `liquidationPriceAt`, `healthFactorAt` + vector generator; cross-check test as in §4.

### Task 6 · `CollateralToken` `clUSDG` (CL-R1…R6)

USDG backing for v1 (6 dp, permit). Transfer rule CL-R3, router-only mint, permissionless `unwrap`, `valuePerToken()`.
Invariant CL-R6. A fork test documents what happens if Paxos freezes the `clUSDG` address (risk finding, as Phase 0 did
for the wrapper). Design so a later ERC-4626 backing (Steakhouse USDG Vault V2) is a new deployment, not an upgrade.

### Task 7 · Deploy scripts (Vault V2)

- `script/DeployStock.s.sol` per stock: `StockWrapper` → `StocklineOracle` → Morpho market (`wSTOCK` / `clUSDG`,
  AdaptiveCurveIRM from `external-addresses.json`, LLTV 77%) → Vault V2 `rSTOCK` from the official factory →
  `MorphoMarketV1AdapterV2` → caps (absolute = launch cap from D8; relative = `U_MAX` design) → fee 10% to a
  `FeeSplitter` placeholder address → roles (owner multisig, curator, allocator keeper, sentinel = guardian) → timelocks
  (48h on harmful curator actions).
- `script/DeployCore.s.sol`: `MarketHours`, `clUSDG`, router, timelock/roles wiring.
- Writes `packages/sdk/addresses.json` keyed by chain id (anvil 31337 and a `fork-4663` key; **never** real 4663).
- Fork test: run the scripts on a fork, then supply/borrow/withdraw through the deployed vault and market.
- Vault V2 code-hash verification from §4.
- Document the listing checklist (03 §5) as `docs/runbooks/list-stock.md`.

### Task 8 · `StocklineRouter` (RT-R1…R7)

- UUPS behind the timelock, stateless between calls, reentrancy-guarded, `deadline` on every entry point.
- Flows: `lend`, `withdrawLend` (Vault V2 deposit/redeem), `borrow`, `openShort`, `closeShort`, `addCollateral`, `repay`,
  `withdrawCollateral`. USDG via EIP-2612 permit (verified) or Permit2.
- Swaps: allowlisted targets only, starting with Uniswap UniversalRouter (A8); balance-delta checks; never trust
  return data (the mock lies to test it).
- Checks on borrow/openShort: guard not tripped, `HF_MIN_OPEN = 1.10` at `t + 24h` including upcoming weekend **and
  event** buffers, per-address caps (D8), global `clUSDG` cap, EIP-712 compliance attestation (RT-R2; signer set by owner).
  Exits never require attestation.
- Events for the indexer. Invariant RT-R5 (router balances always 0) under fuzzing. Gas report for each flow.

### Task 9 · Allocator keeper (`keepers/allocator`, LM-R30…R34 restated for Vault V2)

TypeScript + viem, imports all math/ABIs/addresses from `@stockline/sdk`. Every block (or 30s): allocate/deallocate so
market utilization ≤ `U_MAX`; guard tripped → deallocate all free liquidity within 1 block; pre-earnings pull (D5).
Idempotent, restart-safe, `/health` endpoint, dry-run default, key from env via a signer abstraction (no raw keys in
code). Tests against an anvil fork with the task 7 deployment.

### Task 10 · Guard keeper (`keepers/guard`, OR-R31, R32, D3, D4)

Reads Uniswap v3/v4 pools from `external-addresses.json`, computes a 30-min TWAP, trips/clears per the deviation rules
(3% open, `b_full + 3%` closed, 30-min clear), calls `poke()` for staleness, watches `oraclePaused`/`paused`/blocklist,
detects L2 block-timestamp gaps. Same keeper standards as task 9.

### Task 11 · Fallback liquidator (`keepers/liquidator`)

Watches positions (events + multicall), liquidates via Morpho's callback: seize `clUSDG` → unwrap → swap USDG to
the Stock Token → `wrap` → repay, all in one tx through a small `StocklineLiquidator` contract (tested; no funds held after
the call). Profit and slippage guards. It must work for **any** caller's position, including ones not opened via the router.

### Task 12 · Full lifecycle fork test (Phase 1 exit)

On a fork with the task 7 deployment and mocks only where the chain can't be driven (feed answers via `vm.mockCall` or
a mock aggregator swapped into the oracle at deployment):
lend → open short → Friday ramp-in → weekend hold → Monday gap up → liquidation by the fallback liquidator → lender
withdraws whole. Plus: an NVDA earnings event with the event buffer; the 1e18 feed incident; an issuer pause (guard
trips, exits behavior documented); an `adminBurn` on the wrapper (`backingShortfall` alert). Each scenario asserts
lender assets and bad debt.

## 6. Finish (Phase 1 exit criteria, from `11-milestones.md`)

- `03`, `04`, `05` acceptance criteria all checked, with links to the tests that prove them.
- Update `11-milestones.md` (Phase 1 status), `README.md` status table and `12-open-questions.md` (any new assumptions,
  tagged A9+).
- Final run: `forge fmt --check`, `forge build --sizes` (all contracts < 24 KB), `forge test` with and without
  `ROBINHOOD_RPC_URL`, `forge coverage`, slither, `pnpm -r typecheck`, `pnpm -r test`. Report results honestly, including
  anything skipped or failing.
- End with a short summary: what's built, test and coverage numbers, gas per router flow, open questions for me, and
  what Phase 2 (indexer, API, web app, testnet) needs from this work.
