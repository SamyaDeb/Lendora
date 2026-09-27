# 12 · Open questions and Phase 0 validation

Phase 0 answers these before Phase 1 code depends on them. Each item names the doc it affects and what changes if the answer
is "no".

## Technical validation checklist

`[x]` verified with evidence, `[~]` partly verified (open part stated), `[ ]` open. Decisions: [`../phase0/04-prd-decisions.md`](../phase0/04-prd-decisions.md).

- [x] **Morpho on Robinhood Chain.** Are Morpho Blue and MetaMorpho (factory) deployed? Which IRMs and LLTVs are enabled? *If not:* coordinate a deployment with Morpho, or deploy with governance approval. Affects [03](03-lending-markets.md). **Phase 0 (2026-09-26):** Morpho Blue `0x9D53…1010` live; AdaptiveCurveIRM and `irm 0` enabled; LLTVs 0, 38.5, 62.5, 77, 86, 91.5, 94.5, 96.5, 98% enabled. **No MetaMorpho v1 factory**; Vault V2 factory live → decision D6. Evidence: [01 §2](../phase0/01-chain-facts.md#2-morpho), [02](../phase0/02-fork-validation.md).
- [x] **Stock Token transfers.** Can Stock Tokens be transferred to arbitrary contracts (wrapper, Morpho)? Are there allowlists, blocklists or pause functions held by the issuer? *If restricted:* get the wrapper allowlisted, or the product is blocked. Affects LM-R6, CP-R5. **Phase 0:** transfers into the wrapper and Morpho are exact (fork-tested). No allowlist, but the issuer has a blocklist, per-token and global pause, and `adminBurn`, all held by single keys with no timelock → decisions D4, D9, D10. Evidence: [01 §3](../phase0/01-chain-facts.md#3-stock-tokens), [02](../phase0/02-fork-validation.md).
- [x] **ERC-8056 semantics.** Does the multiplier change balances (rebasing) or only a view? How are cash dividends handled: multiplier, airdrop or USDG? *If airdrop:* the wrapper needs a claim-and-distribute path to lenders and borrowers owe it. Affects LM-R1…R3. **Phase 0:** view only (not rebasing); `uiMultiplier()` is effective at `effectiveAt` without a poke; cash dividends are reinvested via the multiplier. Evidence: [01 §3.3](../phase0/01-chain-facts.md#33-erc-8056-a1-and-dividends).
- [x] **Chainlink feeds.** Which Stock Token feeds exist, their heartbeat and deviation threshold, whether they publish 24/5 or only regular hours, and whether a market-status flag exists. Affects [04](04-oracle.md), OR-R13. **Phase 0:** 33 stock feeds incl. SPY/NVDA/AAPL; 8 dp, 0.5% deviation, 24 h heartbeat while open; 24/5; the pause flag is `oraclePaused()` on the token; feeds already include the multiplier; **no sequencer uptime feed**; launch-week 1e18-scaled answers. Evidence: [01 §4](../phase0/01-chain-facts.md#4-chainlink), [WS-C §0–1](../../sim/reports/phase0-weekend-gaps.md), decisions D1–D4.
- [~] **USDG.** Is there a USDG/USD feed? Which USDG yield vaults exist (for `clUSDG` backing), and can their share price decrease? Affects OR-R4, CL-R1. **Phase 0:** USDG/USD feed exists; USDG is 6 dp with `permit`; Paxos can freeze and wipe. Yield vaults: 54 Morpho Vault V2 USDG vaults (ERC-4626; share price falls on realized bad debt) and Maple syrupUSDG (not ERC-4626 here). **Open (UNVERIFIED):** whether the syrupUSDG rate can fall. Evidence: [01 §5](../phase0/01-chain-facts.md#5-usdg).
- [~] **DEX liquidity.** Which DEXs and pools hold Stock Token liquidity, and what depth within 2% at weekday and weekend hours? Affects guard keeper, liquidation profitability, router swaps. **Phase 0:** Uniswap v3 0.05% USDG and WETH pools hold the main liquidity; 2% depth measured on a Saturday. **BLOCKED:** weekday comparison needs an archive RPC or a weekday rerun of `dex_depth.py`. Evidence: [01 §6](../phase0/01-chain-facts.md#6-dexs-and-aggregators-a8-rt-r3-or-r31), [WS-C §6](../../sim/reports/phase0-weekend-gaps.md).
- [x] **Weekend gap data.** Collect Stock Token onchain price vs Chainlink over every weekend since launch; distribution of premiums and Monday gaps. Affects buffer params, caps. **Phase 0:** onchain premiums and gaps for all weekends since 2026-06-21, plus 10 years of reference gaps. Evidence: [WS-C report](../../sim/reports/phase0-weekend-gaps.md).
- [x] **Finality.** Chain finality and reorg depth for the indexer. Affects SI-R3. **Phase 0:** ~0.1 s blocks; `safe` lags ~11.5 min, `finalized` ~18 min. Evidence: [01 §1](../phase0/01-chain-facts.md#1-network).
- [~] **Liquidators.** Which Morpho liquidator operators run on Robinhood Chain? Will they add `clUSDG` unwrap support? Affects the fallback liquidator's importance. **Phase 0:** 248 Morpho liquidations by 65 distinct callers; none yet in stock-loan markets. **Open:** whether operators will add `clUSDG` unwrap (outreach). Evidence: [01 §8](../phase0/01-chain-facts.md#8-liquidators).
- [~] **Perp venues.** Which venues list these stocks (Lighter, Arcus)? Funding history, depth, weekend trading, and whether contracts can hold margin. Affects [08](08-delta-neutral-vault.md). **Phase 0:** Lighter (RH instance) lists SPY/NVDA/AAPL perps, trades on weekends, publishes hourly funding. Arcus lists stock perps (details unverified). **Open (UNVERIFIED):** contract-held margin accounts. Evidence: [01 §7](../phase0/01-chain-facts.md#7-perp-venues-phase-4).

## Phase 0 decisions (applied 2026-09-27)

All approved decisions from [`../phase0/04-prd-decisions.md`](../phase0/04-prd-decisions.md) are applied to the PRD.

| # | Decision | Applied in |
|---|---|---|
| D1 | `P_wrapped = chainlink(STOCK/USD)`; multiplier for display and guard only | [04 §1](04-oracle.md#1-price-math) (OR-R1, OR-R3, both formulas), OR-R22, [08](08-delta-neutral-vault.md) DN-R4, [07](07-short-interest.md) |
| D2 | `overnightMode` on, overnight buffer 0; `MarketHours` models feed sessions; 4h ramp-in, ramp-out on first fresh round | [04 §2–3](04-oracle.md#2-markethours) (OR-R10, R11, R13, R20, R23), [10](10-risk-compliance.md#launch-parameters) |
| D3 | OR-R6: optional sequencer uptime feed + keeper L2 gap detection | [04 §1](04-oracle.md#1-price-math) (OR-R6), [04 §4](04-oracle.md#4-guards), [10](10-risk-compliance.md) alerts |
| D4 | Guard trips on `oraclePaused()`, `paused()`, blocked wrapper; OR-R7 sanity band | [04 §1, §4](04-oracle.md#4-guards) (OR-R2, OR-R7, OR-R30–R32), [03](03-lending-markets.md) LM-R5 |
| D5 | Event windows + event buffers (NVDA ≥ 10%, AAPL ≥ 8%); pre-earnings liquidity pull; LLTV 77% kept; instant-drop property | [04](04-oracle.md) OR-R8, OR-R10, OR-R14, OR-R20, [03 §4](03-lending-markets.md#4-allocator-keeper-utilization-cap-and-borrow-pause) LM-R31, [05](05-collateral-router.md) RT-R1, [10](10-risk-compliance.md) |
| D6 | Morpho Vault V2 via the official factory; no idle market; relative caps; `deallocate` on guard trip; Sentinel = Guardian | [03 §3–4](03-lending-markets.md#3-lender-vault-morpho-vault-v2-rnvda-d6) (LM-R20–R23, LM-R30–R34), [02](02-architecture.md) contracts and roles, [05](05-collateral-router.md) |
| D7 | A1–A8 status | table below |
| D8 | DEX floor off; caps SPY $1M / NVDA $1M / AAPL $250k; per-address $75k / $250k / $35k; σ 17/52/28%, z 2.5; "~12%" line dropped | [10](10-risk-compliance.md#launch-parameters), [04 §3–4](04-oracle.md#3-closure-and-event-buffers), [05](05-collateral-router.md) RT-R1, [00](00-overview.md), [litepaper](../LITEPAPER.md) |
| D9 | Keep the `StockWrapper` | [03 §1](03-lending-markets.md#1-stockwrapper) |
| D10 | R1 LM-R7 + LM-R8 `backingShortfall`; R2 LM-R5; R3 LM-R6 + optional adapter; R4 comment; R5 mocks; R6 `vault-v2` submodule | [03 §1](03-lending-markets.md#1-stockwrapper), [11](11-milestones.md) tasks 3b, 3c, 7 |

**Proposals raised while applying (need your OK; built as configurable so nothing blocks):**

- **OR-R3 quiet multiplier step.** Phase 0 saw dividend multiplier updates on SPY, NVDA and AAPL with no
  `oraclePaused()` window (01 §3.2–3.3). The strict D1 rule would trip the guard on every dividend and need a 48h
  timelock to clear. Proposed: changes ≤ `maxQuietMultiplierStep` (default 5%) need no pause window; splits and
  anything larger still do. Set it to 0 for the strict rule.
- **Event timing (OR-R14).** The event buffer protects only if the release (first round at/after `endTs`) coincides with
  the jump round, exactly like the Monday open. That makes `endTs` timing-sensitive under a live 24/5 feed. An
  alternative for the sim to evaluate: anchor `P_eff ≥ P_pre-event · (1 + b)` during the window, which is
  timing-robust but needs a stored pre-event price.

## Market validation

- [ ] 15 borrower interviews (kit: [`../phase0/05-interview-kit.md`](../phase0/05-interview-kit.md); pending, run by the owner) (perp makers, arb desks, active traders): would they borrow at 3–15% APR? Which stocks? Which size?
- [ ] 10 lender interviews: what APY would make them deposit? Do they understand manufactured dividends?
- [ ] Perp venue partners: interest in an onchain hedge and in consuming the short-interest API.
- [~] Estimate borrow demand: premium episodes × size that arbitrage would have captured. First pass in [WS-C §8](../../sim/reports/phase0-weekend-gaps.md); interviews pending.

## Product decisions pending

| Question | Default in this PRD | Decide by |
|---|---|---|
| Fees "in USDG" vs lender yield in stock | Lenders earn in stock; protocol share converted to USDG | Phase 1 start |
| DEX floor on the oracle | **Off (D8, applied)** | Revisit only with sim + OR-R8 |
| Overnight buffer when Chainlink is 24/5 | **0, `overnightMode` on (D2, applied)** | Done |
| Per-address caps vs whale borrowers (market makers) | **SPY $75k, NVDA $250k, AAPL $35k; allowlist for larger (D8, applied)** | Revisit with weekday depth |
| Attestation provider (sanctions API) | Chainalysis or TRM | Phase 2 |
| Upgradeable router | Yes, UUPS, 48h timelock | Phase 1 start |
| Brand name (Stockline is a working name) | Stockline | Before public testnet |

## Legal

Questions for counsel: [`../phase0/06-legal-questions.md`](../phase0/06-legal-questions.md). All items pending.

- [ ] Opinion on securities-lending characterization of Stock Token lending in target jurisdictions.
- [ ] Opinion on `rSTOCK`, `clUSDG` and vault shares.
- [ ] Terms of use, risk disclosure, privacy policy.
- [ ] Issuer relationship: does the Stock Token issuer permit lending use? Is there any contractual restriction?

## Phase 1 engineering assumptions (added during build)

Phase 1 started before Phase 0 finished. Code is built against mocks, and each assumption below is isolated behind an
interface or a constructor parameter. Items marked *public docs* come from Robinhood Chain's developer docs
(docs.robinhood.com/chain, read 2026-09-26) and still need an onchain check on a fork.

| # | Assumption | Where it lives | If wrong |
|---|---|---|---|
| A1 | Stock Tokens implement ERC-8056 as published: `uiMultiplier()` (1e18 = 1.0) returns the *effective* multiplier, and scheduled changes are exposed via `newUIMultiplier()` / `effectiveAt()`. *Public docs* confirm the function names. | `src/interfaces/external/IScaledUIAmount.sol`, `StockWrapper.multiplier()` | If `uiMultiplier()` lags until someone pokes, the wrapper and SDK must compute the effective value from `newUIMultiplier`/`effectiveAt`. |
| A2 | Stock Tokens are 18-decimal, non-rebasing, no fee-on-transfer; raw balances never change outside transfers (*public docs*). | `StockWrapper.wrap` reverts if the received amount ≠ `rawAmount` | If fee-on-transfer or rebasing, LM-R1/LM-R7 do not hold and the wrapper design changes. |
| A3 | **Changed (Phase 0, D10 applied):** no allowlist, but an issuer blocklist, token/global pause and `adminBurn`. LM-R6 keeps the optional `IHolderAllowlist` adapter (`address(0)` at deploy); `BlocklistHolderAllowlist` gives a pre-check. | `src/interfaces/IHolderAllowlist.sol` | – |
| A4 | EVM target `cancun` for Robinhood Chain. | `contracts/foundry.toml` | Lower `evm_version` and rebuild. |
| A5 | Holds, but **moot** after D6 (no idle market with Vault V2). | – | – |
| A6 | **Resolved (D6):** Morpho Vault V2 from the official factory; `contracts/lib/vault-v2` pinned at tag `2025-12-04` (`425f6b1`), whose sources match the onchain factories on Sourcify. | `contracts/lib/vault-v2` | – |
| A7 | USDG on Robinhood Chain has 6 decimals and supports EIP-2612 `permit`, like Paxos USDG elsewhere. | `test/mocks/MockUSDG.sol` (decimals are a constructor arg) | Decimals only change test setup (Morpho's price scaling handles any value). No `permit` means the router uses Permit2 only. |
| A8 | Router swaps and guard-keeper prices go through one allowlisted aggregator target called with opaque `swapData`. The real venue is unknown. | `test/mocks/MockSwapAggregator.sol` | Only the mock and the keeper's price source change; RT-R3 already forbids trusting return values (the mock can lie to test that). |

### PRD issues found against public docs (resolved by D1–D5, applied 2026-09-27)

- **OR-R1 double-counts the multiplier.** Robinhood's docs say the Chainlink Stock Token feed "returns the price of one
  token, which is the underlying share price times the multiplier… don't apply the multiplier yourself". The PRD computes
  `P_wrapped = P_stock * m`, which applies it twice. Since one `wNVDA` = one raw token (LM-R1), the fix is
  `P_wrapped = chainlink(NVDA/USD)`. The multiplier then matters only for display (`underlyingEquivalent`) and as a sanity
  guard (OR-R3). *Proposed edit:* change OR-R1's first two lines to `P_wrapped = chainlink(NVDA/USD) // USD per raw token,
  already multiplier-adjusted` and restate OR-R3 as a guard-only check.
- **Feeds are 24/5.** The docs say "Stock feeds update 24/5, following market hours", which answers OR-R13 (yes). Weeknight
  closures likely need little or no buffer, so `overnightMode` should default on.
- **Sequencer uptime is missing.** Robinhood Chain is an L2 and the docs say to check the sequencer before trusting a
  price. The PRD has no sequencer check. *Proposed:* new OR-R6 — the staleness guard also trips while the sequencer is down
  and for a grace period after it comes back; `price()` still never reverts.
- **Oracle pause flag.** The docs mention an advisory pause flag during corporate actions. Its interface is unknown. It
  should probably feed the guard, like the multiplier-jump guard.
- **Morpho's own oracle assumption.** Morpho Blue's current `IMorpho` docs state that the oracle price "should not be
  able to change instantly such that the new price is less than the old price multiplied by LLTV·LIF". At 77% LLTV that is
  about a 17% instant drop. OR-R3's 0.1×–10× multiplier bound and any step change in the buffer must stay inside this. The
  ramp-in already does; confirm again in task 5.

### Phase 1 assumptions added after Phase 0 (A9+)

| # | Assumption | Where it lives | If wrong |
|---|---|---|---|
| A9 | On NYSE early-close days (13:00 ET) the 24/5 feed stops at 17:00 ET (end of the shortened post-market), not 20:00 ET. Conservative: a longer closure and an earlier ramp. No early close has occurred since the feeds launched (first: 2026-11-27). | `packages/sdk/scripts/genSessions.ts` | Regenerate sessions; only the buffer timing on those days changes. |
| A10 | Earnings dates in `packages/sdk/data/events.json` are consensus estimates (NVDA 2026-11-17, AAPL 2026-10-29), `confirmed: false` until the companies announce them; `endTs` = the scheduled release time. | `packages/sdk/data/events.json` | Replace the future window before its ramp starts (`replaceEventsFrom`, timelock). |
| A11 | D8 per-address caps are read as **debt value at the feed price** per address and market (the position a single liquidation must absorb). | `StocklineRouter._positionChecks` | If counsel/risk mean collateral, change the check; the owner can already set overrides. |
| A12 | Vault V2 runs **without a liquidity adapter** (deposits stay idle until allocated, so a deposit during a guard trip adds no borrowable liquidity) and with `forceDeallocatePenalty = 0` (free in-kind exits; misuse can only pull liquidity, which pauses borrows until the allocator re-allocates). | `script/StocklineDeploy.sol` | Set a small penalty (48h timelock) if griefing shows up. |
| A13 | After a genuine > 2× move between `poke`s, the oracle keeps the last good answer until the owner re-anchors through the timelock (OR-R7). The guard keeper pokes every round, so this needs a keeper outage plus a doubling. | `StocklineOracleBase.resetReferences` | Shorter path (guardian re-anchor) if the risk owner prefers liveness over manipulation resistance. |
| A14 | The router's t + 24h health check assumes no fresh round in the horizon (buffers do not release), which is conservative. | `StocklineRouter.healthFactorAt` | – |
| A15 | The Robinhood Chain UniversalRouter (`0x8876…0904`) decodes V3 swaps as `(recipient, amountIn, amountOutMin, path, payerIsUser, uint256[] minHopPriceX36)` (verified: Sourcify source, fork tests). | router/liquidator swap builders | Update the builders if Uniswap redeploys. |
| A16 | Keeper tests run on a plain anvil loaded with the task-7 deployment against mocks of the chain, not on an anvil fork of 4663 (a 316-tx deploy per fork run is slow on the public RPC). The same contracts are exercised on a fork by the forge fork suite. | `keepers/test/fixtures/anvil-state.hex` | Add a fork-mode keeper suite once an archive RPC is available. |
| A17 | Phase 1 fork tests fork **latest** (the public RPC is not an archive node); results are recorded per run, not pinned. | `test/fork/phase1/Phase1ForkBase.sol` | Pin `PHASE1_FORK_BLOCK` with an archive RPC. |

### Open questions from Phase 1 (need your call; nothing is blocked)

1. **OR-R3 quiet multiplier step** (default 5%, `0` = strict D1). See "Proposals raised while applying" above.
2. **Event timing (OR-R14).** Keep "release on the first round at/after the scheduled print", or have the sim evaluate an anchored `P_eff ≥ P_pre-event · (1 + b)` design that does not depend on the exact print time?
3. **`openShort` gas.** Measured ≈ 650k on a fork (cold) vs the 600k placeholder. Accept ≤ 700k, or spend effort on the RT-R1 checks (they read feeds, the calendar and issuer flags twice)?
4. **Aggregator support (A8).** Only Uniswap's UniversalRouter is allowlisted. Adding 0x/1inch needs API keys and a fork test with a live quote.
5. **Archive RPC** for pinned fork runs and weekday DEX depth (still open from Phase 0).

## Phase 2 engineering assumptions (A18+)

Added while building the indexer, API and app. Each is isolated in one SDK function or config value.

| # | Assumption | Where it lives | If wrong |
|---|---|---|---|
| A18 | `supplyApy` (07) = market supply rate × allocated / (idle + allocated) × (1 − performance fee), continuously compounded (`e^(r·365d) − 1`). Vault assets are taken as idle + the adapter's accrued market supply (Vault V2 `maxRate` is set to its maximum, so distributed = real interest). | `packages/sdk/src/shortInterest.ts`, `math/rates.ts` | Change the one function; indexer, API and app follow. |
| A19 | "Current borrow rate" = the IRM's `borrowRateView(params, market())` at the block: the average rate over the pending accrual period, the rate Morpho will apply. The lens reports the same. | `adaptiveCurveBorrowRate` (SDK), `ShortInterestLens` | Report the end-of-period `curve(endRateAtTarget)` instead, in both. |
| A20 | `newShorts24h` / `covered24h` are summed at 1-hour granularity (the current hour plus the 23 before it); "covered" includes the repaid assets of liquidations. | `indexer/src/snapshot.ts` | Use 1m buckets (more lookups per snapshot). |
| A21 | `daysToCover` = borrowed / average daily Stock Token DEX volume over the last 30 days (over the available history if shorter, minimum 1 day). Volume = Uniswap v3 0.05% USDG and WETH pools (fork/mainnet) or the mock swap aggregator (anvil/testnet). Uniswap v4, RFQ and Lighter spot volume are not counted; `null` where no source exists. | `indexer/lib/network.ts`, `shortInterestFields` | Add v4 `PoolManager` swaps or an offchain volume feed. |
| A22 | `marketStatus` precedence: `guard_tripped` (any reason) > `closed` (feed session closed) > `ramping` (open with a buffer in force: closure ramp-in, event buffer, or the hold after a reopen until the first fresh round) > `open`. | `marketStatusOf` (SDK) | One function. |
| A23 | Data is `confirmed` when its block is ≤ the chain's `finalized` tag (~18 min on Robinhood Chain); `safe` is exposed too. | `chain_head` (indexer), API | Use `safe` (~11.5 min). |
| A24 | Exact historical snapshots need an archive RPC (oracle views are read at each block). On a non-archive node the indexer derives totals from events and starts snapshots at the earliest block with state. Same open question as Phase 1 #5. | `indexer/src/snapshot.ts` | Provide an archive RPC for testnet/mainnet. |
| A25 | While the issuer pauses a Stock Token (`TOKEN_PAUSED`), exits that move the Stock Token (`repay`, `closeShort`, `withdrawLend`, `unwrap`) revert in the token itself (LM-R5). USDG-side exits (`withdrawCollateral` while healthy) still work. The app keeps exits enabled and explains the issuer pause when a simulation fails this way (found by the Phase 2 chain driver). | `web/` (APP-R4 copy), `docs/runbooks/testnet.md` | – (issuer behavior; disclosed). |
| A26 | Robinhood Chain testnet has no Morpho Blue, Vault V2, USDG, Stock Tokens or Chainlink feeds (01-chain-facts §10), so the testnet deployment brings its own unmodified Morpho Blue / AdaptiveCurveIrm / Vault V2 factories (pinned artifacts) and gated mocks; a feed-mirror keeper copies real mainnet Chainlink rounds (read-only) to the mock feeds, so testnet sees real prices and real 24/5 closures. | `contracts/script/DeployTestnet.s.sol`, `keepers/src/feedMirror` | If Robinhood or Morpho publish testnet deployments, point `DeployTestnet` at them instead. |
| A27 | On testnet one deployer key holds every role by default (owner via a 24h timelock, curator, guardian, allocator, keepers) and is a mock operator. Roles can be split by env (`STOCKLINE_*`). | `DeployTestnet.configForTestnet` | Split roles before inviting external testers if the owner prefers. |
| A28 | Phase 1 test mocks gained an opt-in operator gate (`MockGate`, off by default; tests unchanged) so a public testnet cannot have its prices, pauses or mints rewritten by anyone. | `contracts/test/mocks/MockGate.sol` | – |

### Remediation assumptions (A29+, 2026-09-28)

| # | Assumption | Where it lives | If wrong |
|---|---|---|---|
| A29 | The indexer derives `vault_idle` from Vault V2 events, so a plain `wSTOCK` transfer into a vault (a donation) moves the onchain idle balance without being indexed. SI-R5 reconciliation reports it and the monitor keeps an `INDEXER_LAG:reconcile` (P2) incident open until fixed (found by the task 3 monitor test with a real donation). Idle feeds display values only (`supplyApy`, `utilizationVault`), never safety math. | `indexer/src/index.ts`, `keepers/test/monitor.test.ts` | Derive idle from wrapper `Transfer` events to/from the vault (or read `balanceOf` at snapshot time). |
| A30 | The monitor treats event rules (`BAD_DEBT`, `DIRECT_BORROW`) as resolved 24h / 1h after they page; the provider keeps the history and the runbook drives follow-up. `DIRECT_BORROW` dedupes per (market, borrower). | `keepers/src/monitor/rules.ts` | Resolve only by operator ack. |
| A31 | `PULL_NOT_EFFECTIVE` ignores free liquidity up to 1e15 raw units (the allocator's minimum move), and utilization is vault-level (07 `utilizationVault`), since market-level utilization is routinely ~100% of what the vault allocates. | `keepers/src/monitor/monitor.ts` | Change the two options. |

### Open questions from Phase 2 (need your call; nothing is blocked)

1. **Go for testnet**: the deployment, keepers and services wait for your go, a deployer key (`TESTNET_DEPLOYER_KEY` or a remote signer) and, ideally, an archive testnet RPC (the public one is not archive, A24).
2. **Sanctions provider** (CP-R3): Chainalysis or TRM. Both adapters exist; the deny-list runs until a key is provided.
3. **Hosting**: Railway (config in `infra/`) plus an edge platform that sets geo headers (Vercel or Cloudflare) for the web app; WalletConnect project id; email (Resend) and Telegram bot for alerts.
4. **Terms of use / risk disclosure**: the draft in `compliance/terms/` needs counsel (CP-R6) before external testers sign it.
