# Stockline · audit package (Phase 4: USDG Earn, delta-neutral vault)

Scope, architecture, roles and trust, integrations, invariants with their tests, how to run them, and the known issues
we accept, for the **delta-neutral vault** (PRD [08](../../prd/08-delta-neutral-vault.md), DN-R1…R14) and the
deployment logic that ships it. The Phase 1–3 package is [../README.md](../README.md); the threat model
[../threat-model.md](../threat-model.md) applies unchanged to everything it covers. Offchain code added in Phase 4
(NAV reporter and co-signer, DN rebalancer, `/v1/vault/*`) is reviewed in [../offchain-review.md](../offchain-review.md)
§5 (OFF-18…OFF-22).

*Prepared 2026-09-29 (Phase 4 task 18). Working name "Stockline" (brand decision Q6 pending; nothing renamed).*

## 1. Scope

**Freeze.** The Phase 4 round covers the tree at the commit recorded in [`FREEZE`](FREEZE) (the commit that adds this
package). Fixes during the audit land as new commits recorded in §8; the diff from the freeze is the re-review scope
([../fix-workflow.md](../fix-workflow.md)). Tag it with `git tag audit-p4-freeze $(cat docs/audit/phase4/FREEZE)` when
the owner confirms.

Same compiler settings as round 1 (Solidity 0.8.26, cancun, 200 runs, `bytecode_hash = none`). nSLOC = non-blank,
non-comment lines.

| File | nSLOC | What it is | Upgradeable |
|---|---:|---|---|
| `src/vault/DeltaNeutralVault.sol` | 315 | ERC-4626 over USDG (share offset 12) + ERC-7540-style FIFO redeem queue. Deposits need a compliance attestation (A42) and a live NAV in an open feed session (DN-R5, DN-R12); instant exits up to idle cash; `requestRedeem` / `settle` / `claim`; 10% performance fee above the high-water mark (DN-R9); total cap and guardian pause (DN-R6) | No (owner = timelock) |
| `src/vault/StrategyManager.sol` | 316 | Holds the strategy's spot, `rSTOCK` and the perp adapter. Operator trades within bounds: allowlisted swap targets, **every swap floored at the oracle price ± 1%** measured on balance deltas, sleeve caps, `maxLendBps`, short ≤ spot; guardian unwind path; kill switch per sleeve (DN-R7); `tradeNonce` for DN-R14 | No |
| `src/vault/NavOracle.sol` | 179 | NAV = cash + spot (feed) + `rSTOCK` value + perp equity (DN-R4). Perp equity from EIP-712 reports; > 1% move or > 1% of accumulated single-signed moves needs two signers; between reports the short is marked to the feed (DN-R14); freshness per session (DN-R5) | No |
| `src/interfaces/IDeltaNeutralVault.sol` | 71 | Interface, events, errors | – |
| `src/interfaces/IStrategyManager.sol` | 82 | Interface, events, errors, `Sleeve` | – |
| `src/interfaces/INavOracle.sol` | 39 | Interface, `Report`, errors | – |
| `src/interfaces/IPerpAdapter.sol` | 20 | The venue boundary: `deposit` / `requestWithdraw` / `pending` / `adjustShort` / sizes / flow totals | – |
| **Total new `src/`** | **1,022** | | |

Runtime sizes (`forge build --sizes`): `DeltaNeutralVault` 12,499 B, `StrategyManager` 15,008 B, `NavOracle` 10,033 B.
`StocklineRouter` is **unchanged** at 24,092 B (484 B headroom).

**Deployment logic in scope** (as in rounds 1–2):

| File | nSLOC | What it does |
|---|---:|---|
| `script/DnVaultDeploy.sol` | 164 | `_deployDnVault`: vault, strategy, oracle, adapter wiring, roles, handover to the timelock. **MN-R7**: on chain 4663 it refuses a mock venue and any non-zero cap |
| `script/MainnetConfig.sol` | 225 | Adds `DnRoles` from `STOCKLINE_DN_OPERATOR`, `STOCKLINE_NAV_SIGNER_1/2` and **MN-R8** `_assertDnRoles` (distinct, non-zero, not the deployer, not another Stockline role) |
| `script/VerifyRoles.s.sol` | 472 | Read-only; new `_dn` section (owners, operator, signers, caps 0, adapter) |
| `script/ReceiptMarketDeploy.sol`, `script/ListReceiptMarket.s.sol` | 152 + 101 | G5 receipt market (A3): stage 1 deploys with caps 0; listing is the curator's timelocked step, CL-R10 window enforced on 4663 |
| `script/DeployTestnetVault.s.sol` | 76 | Testnet DN vault on the existing 46630 deployment: **mock venue, caps 0** |

**Out of scope.** Frozen Phase 1–3 files (§8.3 shows no diff), Morpho, OpenZeppelin, everything under `test/`
(including `test/mocks/MockPerpVenue.sol`, the gated venue + adapter used on anvil and testnet), the Lighter venue
itself, and **the production perp adapter**, which is not written: it waits on the `[VERIFY]` items of
[01-perp-venue.md](../../phase4/01-perp-venue.md) and the sim gate. Mainnet deploys the vault with **no adapter and caps
0** (MN-R7), so nothing can be deposited until the owner sets caps through the timelock after both gates.

## 2. Architecture

```
 user ── deposit(assets, receiver, attestation) ──► DeltaNeutralVault (USDG Earn, dnUSDG shares)
      ◄─ withdraw/redeem (instant, ≤ idle) ─────────┤  cash buffer (idle USDG)
      ── requestRedeem ─► FIFO queue ─ settle(n) ───┤  settles at the NAV of settlement; claim() any time after
                                                    │ sendToStrategy (buffer kept; refused while the queue is overdue)
                                                    ▼
                           StrategyManager (operator trades, guardian unwinds)
             ┌──────────────────────┼─────────────────────────┬────────────────────────┐
     swap (allowlisted target,   lend/unlend               depositMargin /         adjustShort
     oracle ±1% floor)           wSTOCK → rSTOCK vault     requestMarginWithdraw   (tradeNonce++)
             ▼                      ▼                         ▼                        ▼
      spot Stock Tokens      Vault V2 rSTOCK (Phase 1)      IPerpAdapter ───────► perp venue
                                                         (mock on anvil/testnet;   (Lighter, [VERIFY])
                                                          none on mainnet yet)
                                    ▲
 NavOracle ◄── submit(report, sigs) ── NAV reporter keeper ◄──► NAV co-signer (independent source)
   nav() = cash + spot@feed + rSTOCK + perp equity (report, marked to the feed between reports, DN-R14)
   fresh() gates deposits, instant exits and settlement (DN-R5, DN-R12)
```

Offchain: the **DN rebalancer** (`keepers/src/dnRebalancer`) plans kill → queue → margin → delta → lending → build each
tick; the **NAV reporter** / **co-signer** (`keepers/src/navReporter`); the monitor rules MON-R21…R25; the indexer's
`dn_*` tables and `/v1/vault/*`; the web app's USDG Earn page on the real vault.

## 3. Roles and trust assumptions

| Actor | Powers | Trust assumption | If compromised |
|---|---|---|---|
| Owner: timelock (48h, 4-of-7 multisig) | Vault: total cap, fee recipient, one-time wiring. Strategy: add sleeves, sleeve caps, `maxLendBps`, swap targets, `setAdapter` (only when flat). Oracle: NAV signers, max ages | Honest majority; 48h to exit | Could list a malicious swap target or adapter, or add a colluding NAV signer; users see it 48h ahead and can exit instantly up to the cash buffer; a queued request may settle only after the change executes (known issue 7) |
| Guardian: 2-of-4 multisig | Vault: `lowerTotalCap`, `setDepositsPaused`. Strategy: `setPaused` (blocks new exposure only), `killSleeve`, unwind (`sell`, `unlend`, `returnToVault`, margin withdraw, `adjustShort` toward 0) | Can only reduce risk | Griefing: pause entries, unwind into the ±1% floors (bounded cost per trade) |
| Strategy operator (keeper EOA / KMS) | `pullFromVault`, buy/sell spot, lend/unlend, margin in/out, `adjustShort`, `killSleeve` | Liveness; trades within onchain bounds (DN-R10) | Onchain: every swap ≥ oracle price − 1% (buy: ≤ + 1%) on measured balances, only allowlisted targets, no path to itself (tested), short ≤ spot, sleeve caps. **Offchain on the venue (A40):** an API key can trade any market at any price, so a compromised operator can bleed the perp margin through wash trades against an account it controls. Bounded by the margin share of NAV (≈ 24% at L = 3), detected by the co-signer's equity check and MON-R22/R23, contained by the guardian (pause, kill, unwind) |
| NAV signers (2 keys: reporter + independent co-signer) | Set perp equity in NAV | Each key alone moves NAV ≤ 1% in total between co-signed reports; both together are fully trusted for the perp side | One key: ≤ 1% of NAV mispricing (was unbounded by chaining before this package: §8.1). Two keys: arbitrary perp equity → mints/burns at a wrong price; monitor MON-R23 (`DN_NAV_STALE`) does not catch a *wrong* NAV, only a stale one (known issue 2) |
| Compliance signer | Attestations for deposits (A42, shared with the router) | As round 1 | As round 1; exits never need an attestation |
| Perp venue (Lighter) | Holds the margin; liquidates; sequencer | Solvent, orderly; secure withdrawals return only to the owning L1 address (the adapter) | Venue failure = loss of the margin share of the sleeve (≤ 24% of the sleeve at L = 3); halt → queue settlement waits for the venue, spot side redeemable (known issue 4) |
| Chainlink feeds | Spot value, swap floors, DN-R14 marking | As round 1 | As round 1; a closed session pauses mint/burn (DN-R12) |

## 4. External integrations

| Integration | Where | Notes |
|---|---|---|
| Stockline Phase 1–3 (router attestation digest, `MarketHours`, `StocklineOracle.quote`, wrappers, rSTOCK Vault V2) | vault, strategy, oracle | Read-only use of frozen contracts; `rSTOCK` deposits/redeems through Vault V2's ERC-4626 |
| Uniswap UniversalRouter (4663) / mock aggregator (anvil, testnet) | `StrategyManager` swaps, `Transfer` mode | Output measured by balance delta; floor from the Stockline oracle, never from the calldata |
| Lighter (Robinhood Chain instance) | future production adapter | Contract-held accounts via onchain `changePubKey` (fork-verified selectors); 5 `[VERIFY]` items in [01-perp-venue.md](../../phase4/01-perp-venue.md) §2; **no adapter shipped** |
| `MockPerpVenue` (test only) | anvil, testnet | Gated venue + adapter: funding, liquidation, withdrawal delay, halt switch |

## 5. Invariants and properties (with tests)

All tests are in `contracts/test/vault/` unless noted. Invariant suite `DnVaultInvariant.t.sol` (handler: deposits,
exits, requests, settles, claims, builds, price moves, funding, reports, guardian unwinds).

| ID | Property | Tests |
|---|---|---|
| DN-R1 | The queue is FIFO; escrowed shares equal the sum of open requests; claims are never gated | `invariant_DN_R1_queueIsFifoAndBooked`; `test_DN_R1_queueSettlesFifoAtSettlementNavAndClaimsNeverGated`, `test_DN_R1_requestWithAllowanceAndSettlePriceIsFair` |
| DN-R1 | Any queue is settleable after the guardian's unwind (exits are never blocked) | `invariant_DN_R1_queueAlwaysSettleableAfterAnUnwind` (found the between-reports flaw fixed by DN-R14) |
| DN-R1 | Settlement deadline = max(t + 72h, next US open) | `test_DN_R1_settleByIs72hOrTheNextUsOpenWhicheverIsLater`, `test_DN_R1_settleByPastTheCalendar` |
| DN-R1 | Instant exits need no attestation; `sendToStrategy` keeps the buffer and serves an overdue queue first | `test_DN_R1_instantWithdrawUpToIdleWithoutAttestation`, `test_DN_R1_sendToStrategyKeepsTheBufferAndServesAnOverdueQueueFirst` |
| DN-R2 | Short ≤ spot; only the operator adds exposure | `test_DN_R2_shortCannotExceedSpotAndOnlyTheOperatorAddsIt` |
| DN-R3 | Margin returns only to the strategy | `test_DN_R3_marginPathReturnsOnlyToTheStrategy` |
| DN-R4 | NAV = cash + spot + perp; a hedged sleeve's NAV barely moves with price | `test_DN_R4_navIsCashPlusSpotPlusPerp`, `test_DN_R4_hedgedSleeveNavBarelyMovesWithThePrice` |
| DN-R4 | One signer ≤ 1%, two above; distinct, allowed, sorted signatures; **single-signed moves accumulate** | `test_DN_R4_oneSignerUpToOnePercentTwoAbove`, `test_DN_R4_signaturesMustBeDistinctAllowedAndSorted`, `test_DN_R4_singleSignerMovesAccumulateUntilACosignedReport` |
| DN-R4 | A report can't claim flows the adapter hasn't made; flows since the report count once | `test_DN_R4_aReportCannotClaimFlowsTheAdapterHasNotMade`, `test_DN_R4_flowsSinceTheReportCountOnceAndPendingWithdrawalsStayInNav` |
| DN-R5 | No mint or burn on a stale NAV; report timing (newer, not future, within max age) | `test_DN_R5_noMintOnAStaleNav`, `test_DN_R5_reportTimingRules`, `test_DN_R5_freshnessMaxAgeAndGuards`, `test_DN_R5_R12_instantExitsWaitButRequestsAlwaysWork` |
| DN-R6 | Total cap and sleeve caps hold under every sequence; cap 0 refuses every deposit | `invariant_DN_R6_totalCapAndSleeveCaps`; `test_DN_R6_capZeroRefusesEveryDepositAndGuardianLowersTheCap`, `test_DN_R6_sleeveCapBoundsSpot` |
| DN-R6 / A42 | Plain ERC-4626 `deposit`/`mint` revert; the attested path checks the router's digest and signer | `test_DN_R6_plainErc4626DepositAndMintNeedAnAttestation`, `test_CP_R3_badOrExpiredAttestationRefused` |
| DN-R7 | The kill switch stops new exposure, never the unwind | `test_DN_R7_killSwitchStopsNewExposureButNotTheUnwind` |
| DN-R8 | Lending bounded by `maxLendBps` | `test_DN_R8_lendRatioBounded` |
| DN-R9 | 10% fee above the HWM; none on a stale NAV or before deposits | `test_DN_R9_feeIsTenPercentAboveTheHighWaterMark`, `test_DN_R9_noFeeOnAStaleNavAndNoneBeforeDeposits` |
| DN-R10 | The operator holds nothing and has no path to itself; floors ±1% on measured output; allowlisted targets, never a holding contract | `invariant_DN_R10_operatorHoldsNothing`; `test_DN_R10_*` (8) |
| DN-R12 | No mint while the feed session is closed | `test_DN_R12_noMintWhileTheFeedSessionIsClosed` |
| DN-R14 | NAV stays hedged between reports; a perp trade waits for a report that saw it | `test_DN_R14_navStaysHedgedBetweenReports`, `test_DN_R14_aPerpTradeWaitsForAReportThatSawIt` |
| MN-R7/R8 | Mainnet deploy: no mock venue, caps 0, DN roles distinct | `test/deploy/Mainnet*.t.sol` (`MN_R7_*`, `MN_R8_*`) |
| Fork (4663) | Lifecycle on the live UniversalRouter, feeds and rSTOCK vault (deposit, build, rebalance, withdraw, queue, weekend, kill, top-up); margin top-up; 4 stresses: +20% Monday gap, funding −100% APR for a week, venue withdrawals halted 72h, rSTOCK utilization 100% for 48h | `test/fork/phase4/DnVault.fork.t.sol` (6) |
| Keepers | A simulated week on anvil (real Lighter funding): delta in band on 100% of 1,008 sleeve-ticks, 0 errors | `keepers/test/dnWeek.test.ts` |

Coverage (`forge coverage --ir-minimum`, 2026-09-29): `DeltaNeutralVault` 95.3% lines, `NavOracle` 100%,
`StrategyManager` 97.5%.

## 6. Build and run

```sh
cd contracts
forge build --sizes
forge test --match-path "test/vault/*"                                   # 49 unit + 4 invariants
FOUNDRY_PROFILE=deep forge test --match-contract DnVaultInvariantTest     # deep invariant run
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-path "test/fork/phase4/*"
forge coverage --ir-minimum --report summary
slither .                                                                 # no medium+; triage in slither.config.json
cd .. && pnpm --filter @stockline/keepers exec vitest run test/dnVault.test.ts test/dnWeek.test.ts test/monitorDn.test.ts
```

The sim gate lives in `sim/dn_vault` (report: [sim/reports/phase4-dn-vault.md](../../../sim/reports/phase4-dn-vault.md)).

## 7. Known issues and accepted risks

1. **Venue key trust (A40).** Lighter API keys are not scoped: the operator key can trade any market at any price.
   Wash trades against a colluding account move margin value out; bounded by the margin share of NAV, caught by the
   co-signer's equity check (≤ 25 bps + 1 USDG tolerance) and MON-R22/R23, contained by the guardian. If Lighter adds
   key scopes, register the operator key as trade-only ([VERIFY] 2).
2. **NAV signer trust (A41).** Perp equity is not readable onchain; two colluding signers can set any perp equity.
   A single key is bounded to 1% of NAV in total until a co-signed report (§8.1). Operational separation: the
   co-signer runs on its own host, reads the venue through its own source, and signs only what it recomputes.
3. **`[VERIFY]` gaps.** EIP-1271 behavior, key permissions, instance parity (verified source on 4663), end-to-end
   contract registration (needs a live $10 canary with the owner's go) and withdrawal latency
   ([01-perp-venue.md](../../phase4/01-perp-venue.md) §2). Until closed, **no production adapter exists** and mainnet
   runs with no adapter and caps 0.
4. **Venue halt or loss.** Margin withdrawals wait while the venue is halted; instant exits from the buffer keep
   working and requests are accepted (fork stress `test_DN_stress_fork_venueHaltsWithdrawals72h`, which also checks the
   margin posted ≤ 23.75% of NAV); a queue larger than cash + spot waits for the venue to resume. A venue loss is borne by the vault up to the margin share
   (`test_venueLossFloorsPerpAtZero`: perp value floors at 0, never negative).
5. **1% per swap is the operator's bound, not 0.** Each swap may lose up to 1% against the oracle (DN-R10). A
   compromised operator could churn buys and sells at the floor; each round trip costs ≤ 2% of the traded amount,
   limited by sleeve caps and detectable (MON-R21 delta, volume). Guardian pause stops it.
6. **DN-R13 kill-switch trigger is a proposal.** The 08 default (7-day average, 72h) exceeds the 2% drawdown bound in
   the −100% APR funding week (2.35%); the sim's 24h/24h trigger holds it at 1.74%. Configurable in the keeper
   (`DN_KILL_WINDOW_H`, `DN_KILL_HOURS`); the risk owner picks ([sign-off sheet](../../owner-actions/dn-vault-signoff.md)).
7. **Queue vs timelock.** Settlement can take up to 72h (or the next US open) while owner changes are delayed 48h: a user
   who requests on announcement may still hold shares when a malicious change executes. Instant exits up to the
   buffer are immediate. Accepted with the same governance trust as round 1; a longer DN timelock is an [OWNER] option.
8. **Dynamic `LEND_RATIO` (A44).** DN-R8 is enforced in the rebalancer (others × idle share), onchain only as
   `maxLendBps`. A compromised operator can lend up to `maxLendBps` regardless of rSTOCK utilization.
9. **Sim verdict INSUFFICIENT DATA.** 94 days of Lighter funding history; the gate needs the risk owner's sign-off on
   what the data supports. Caps stay 0 everywhere until then.
10. **One-shot entry cost** ≈ 1.54% (swap floor use, venue fees, spread) is paid by the vault on build; early share
    price dips below 1.0 until funding covers it (disclosed on the page, CP-R7).
11. **Attestation shared with the router (A42).** A router attestation is valid for a vault deposit and vice versa.

## 8. Changes after the Phase 3 round-2 scope

### 8.1 Pre-freeze fixes made while preparing this package

| File | Why | Test |
|---|---|---|
| `src/vault/NavOracle.sol`, `src/interfaces/INavOracle.sol` | One NAV signer could chain sub-1% reports (a report only needs a newer timestamp), walking NAV arbitrarily in a few blocks. Single-signed moves now accumulate in `unconfirmedMoveBps`; above 1% a second signer is needed; a co-signed report resets it. The reporter asks the co-signer on every report | `test_DN_R4_singleSignerMovesAccumulateUntilACosignedReport` (failed before: the third chained −0.4% report was accepted); `test_DN_R4_oneSignerUpToOnePercentTwoAbove` now expects 199 bps (90 unconfirmed + 109) |

### 8.2 New Phase 4 files

§1. Deployment logic: §1 table. Keepers and API: [offchain-review.md](../offchain-review.md) §5.

### 8.3 Post-freeze diff of frozen files

**None.** `git diff 84bfc62 HEAD -- contracts/src` lists only new files (the Phase 3 fee contracts and the seven Phase 4
files above). Router runtime unchanged (24,092 B). Fixes during this round are recorded here as
`file · commit · why · failing-first test`.

No `src/` file changed after the Phase 4 freeze. Deployment logic (in scope) changed as follows:

| File | Commit | Why | Failing-first test |
|---|---|---|---|
| `script/DeployTestnetVault.s.sol` | `4ed9a8e` | Part C fork rehearsal: the fee recipient was read from `roles.treasury`, which the 46630 book never had, so the script could not run on testnet. Now the `FeeSplitter` (book, or the fork rehearsal's output), refused otherwise | `test/deploy/DeployTestnetVault.t.sol` |
| `script/VerifyRoles.s.sol` | Part D commit | **Launch blocker found by the launcher's dry run:** the DN sleeve check compared sleeve *i* with stock *i*; `deployments/4663.json` lists stocks alphabetically while sleeves are in deploy order, so VerifyRoles would have failed on the real launch. Matched by vault now, each stock once | `test_MN_R5_verifyRolesReadsTheWrittenAddressBook` (now writes `.dnVault` as `DeployMainnet` does) |
| `script/DeployMainnet.s.sol` | Part D commit | The deployment body moved into `_launch(deployer, out)` so the dry run runs the same code; `run()` and its MN-R4 refusal are unchanged | `test/deploy/DeployMainnet*.t.sol` (unchanged, pass) |
| `script/DeployMainnetDryRun.s.sol` (new) | Part D commit | The launcher's `--dry-run`: anvil fork of 4663 only (`web3_clientVersion`), refuses the go and the real output name | `test/deploy/DeployMainnetDryRun.t.sol` |
