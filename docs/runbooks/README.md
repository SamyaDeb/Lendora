# Runbooks

One page per P0/P1 alert of the ops monitor ([10 "Monitoring and paging"](../prd/10-risk-compliance.md#monitoring-and-paging),
MON-R1…R25), plus the operational procedures they share. Every page has the same shape: **trigger → impact → first 5
minutes → decision tree → exact commands → who signs → comms → post-mortem**.

| Alert (rule) | Sev | Runbook | Rehearsed on anvil | Rehearsed on a fork of 46630 | Drilled on testnet |
|---|---|---|---|---|---|
| `BAD_DEBT` (MON-R1) | P0 | [bad-debt.md](bad-debt.md) | detection: monitor test; response: delist + `repay` ([runbooks.test.ts](../../packages/devnet/test/runbooks.test.ts)) | – | ⏳ needs "go testnet" |
| `MISSED_LIQUIDATION` (MON-R2) | P0 | [missed-liquidation.md](missed-liquidation.md) | detection + standard liquidation: monitor test | – | ⏳ needs "go testnet" |
| `BACKING_SHORTFALL` (MON-R3) | P0 | [wrapper-backing-shortfall.md](wrapper-backing-shortfall.md) | detection (`adminBurn`): monitor test; delist: runbooks test | fork 46630, 2026-09-28 ([report](fork-drills-46630.md) #11: P0 tabletop, adminBurn → delist) | ⏳ needs "go testnet" |
| `CLUSDG_BACKING` (MON-R4) | P0 | [usdg-freeze.md](usdg-freeze.md) | detection (USDG wipe): monitor test; delist: runbooks test | – | ⏳ needs "go testnet" |
| `ORACLE_STALE` / `FEED_REJECTED` (MON-R5/R6) | P1 | [oracle-stale-or-rejected.md](oracle-stale-or-rejected.md) | detection: monitor test; re-anchor through the timelock: runbooks test | fork 46630, 2026-09-28 ([report](fork-drills-46630.md) #8: `resetReferences`) | ⏳ needs "go testnet" |
| `GUARD_TRIPPED` / `PULL_NOT_EFFECTIVE` (MON-R7/R11) | P1 | [guard-tripped.md](guard-tripped.md) | manual trip → pull → clear: runbooks + monitor tests | fork 46630, 2026-09-28 ([report](fork-drills-46630.md) #5) | trip → clear live, 2026-09-29 (live-drills pass 1); monitor paged and resolved |
| issuer pause / blocklist (`GUARD_TRIPPED` TOKEN_PAUSED, WRAPPER_BLOCKED) | P1 | [issuer-pause-or-blocklist.md](issuer-pause-or-blocklist.md) | pause → USDG exit → unpause: runbooks test | – | ⏳ needs "go testnet" |
| `L2_GAP` (MON-R8) | P1 | [sequencer-l2-gap.md](sequencer-l2-gap.md) | detection: monitor test | – | ⏳ needs "go testnet" |
| `KEEPER_DOWN` (MON-R9) | P1 | [keeper-down.md](keeper-down.md) | detection: monitor test | fork 46630, 2026-09-28 ([report](fork-drills-46630.md) #6: guardian deallocates by hand) | ⏳ needs "go testnet" |
| `LOW_GAS` / `LOW_GAS_CRITICAL` (MON-R15) | P1 / P0 | [low-gas.md](low-gas.md) | detection (configured and measured burn): monitor test | – | ⏳ needs "go testnet" |
| `DIRECT_BORROW` (MON-R10) | P1 | [direct-borrow.md](direct-borrow.md) | detection: monitor test; global cap through the timelock: runbooks test | – | ⏳ needs "go testnet" |
| `CALENDAR_RUNWAY` (MON-R13) | P2 | [calendar-push.md](calendar-push.md) | detection: monitor test; event push through the timelock: runbooks test | fork 46630, 2026-09-28 ([report](fork-drills-46630.md) #9) | ⏳ needs "go testnet" |
| multiplier change (`GUARD_TRIPPED` MULTIPLIER) | P1 | [multiplier-change.md](multiplier-change.md) | latch → confirm through the timelock: runbooks test | fork 46630, 2026-09-28 ([report](fork-drills-46630.md) #7) | ⏳ needs "go testnet" |
| `TIMELOCK_SCHEDULED` / `TIMELOCK_EXECUTED` (`_UNTRACKED`) / `ROLE_CHANGED` (MON-R16…R18) | P1 / P0 | [governance-change.md](governance-change.md) | detection through the real timelock (tracked and untracked), `SetIsSentinel`: monitor test | fork 46630, 2026-09-28 ([report](fork-drills-46630.md) #10: decode + cancel) | decode + cancel live, 2026-09-29; two-step scheduled (executes in pass 2); monitor paged `TIMELOCK_SCHEDULED` |
| `LIQUIDATION_UNPROFITABLE` (MON-R19) | P1 | [missed-liquidation.md](missed-liquidation.md) | detection (HF < 1, DEX route 20% worse): monitor test | – | ⏳ needs "go testnet" |
| `FEE_NOT_DISTRIBUTED` (MON-R20) | P2 | [keeper-down.md](keeper-down.md) | detection (fee shares waiting), resolved by `distribute`: monitor test | fork 46630, 2026-09-28 ([report](fork-drills-46630.md) #1–4: fee on through the 24h timelock, first distribution and conversion) | ⏳ needs "go testnet" |
| `DN_DELTA_BREACH` (MON-R21) | P1 | [dn-delta-breach.md](dn-delta-breach.md) | detection: `monitorDn.test.ts`; realignment: `dnVault.test.ts` | vault flows: fork 46630, 2026-09-29 ([report](fork-drills-46630.md)) | ⏳ needs "go testnet" and a cap |
| `DN_MARGIN_LOW` (MON-R22) | P0 | [dn-margin-low.md](dn-margin-low.md) | detection: monitor test; top-up from cash then spot: `dnVault.test.ts`, fork `test_DN_R3_fork_marginTopUp` | – | ⏳ |
| `DN_NAV_STALE` (MON-R23) | P1 | [dn-nav-stale.md](dn-nav-stale.md) | detection: monitor test; co-signer refusals: `dnVault.test.ts` | – | ⏳ |
| `DN_QUEUE_OVERDUE` (MON-R24) | P0 | [dn-queue-overdue.md](dn-queue-overdue.md) | detection: monitor test; raise cash and settle: `dnVault.test.ts` | queued withdrawal → settle → claim: fork 46630, 2026-09-29 | ⏳ |
| `DN_KILL_SWITCH` (MON-R25) | P1 | [dn-kill-switch.md](dn-kill-switch.md) | detection: monitor test; kill + unwind: `dnVault.test.ts` | – | ⏳ |

Rehearsals: `pnpm --filter @stockline/devnet test` (runbooks.test.ts, real TimelockController with the calldata from
the SDK tool) and `pnpm --filter @stockline/keepers test` (monitor.test.ts). **Fork rehearsal (Phase 3 task 11, no "go testnet"):**
[fork-drills-46630.md](fork-drills-46630.md) — the fee turn-on and every mainnet-launch §0 drill (guard-tripped, oracle
re-anchor, calendar-push, multiplier-change, keeper-down, governance-change, P0 tabletop: wrapper shortfall) ran on an
anvil fork of 46630 against the real testnet deployment and its 24h timelocks, 8/8 passing
(`FORK_DRILLS_46630=1 pnpm --filter @stockline/devnet exec vitest run test/forkDrills.test.ts`). **Testnet drills**
(the same steps on 46630, with date, tx hashes and who ran each) wait for the owner's "go testnet"; the fee contracts
are deployed there with `contracts/script/DeployTestnetFees.s.sol` (`TESTNET_GO=yes`). Weekend log:
[testnet-weekends.md](testnet-weekends.md).

**Phase 4 Part C (2026-09-29, still no "go testnet"):** the fork report now also covers `DeployTestnetVault` and the
USDG Earn flows (9/9 drills, 14 steps). The live path is `pnpm --filter @stockline/devnet drive live-drills` (see
[testnet.md](testnet.md) §2): immediate drills at once, timelocked halves on a re-run after 24h, refusing 4663 and
refusing 46630 without `TESTNET_GO=yes`, the key and `DRILL_RAN_BY`; evidence goes to `live-drills-46630.json` and the
markdown row it prints goes in the table below. Rehearsed in two passes on a fork (`test/liveDrills.test.ts`).

| Date | Chain | Drills (live-drills) | Ran by | Evidence |
|---|---|---|---|---|
| 2026-09-29 12:03 UTC | 46630 (live) | pass 1: guard trip → clear (`0x06dc…b21b`, `0x7ae8…9d8a`), governance-change decode + cancel (`0xdd19…94c`, `0xd723…361f`) done; owner-timelock two-step (`0x7173…c778`) and fee turn-on in 3 vaults (`0xc0f2…3940`, `0x8f67…3660`, `0xf769…3d76`) scheduled, executable after 2026-09-30 12:03 UTC (pass 2); USDG Earn cap read (1,000,000 test USDG, A49). Monitor paged `GUARD_TRIPPED` and `TIMELOCK_SCHEDULED` | SamyaDeb (via Claude Code) | [`live-drills-46630.json`](live-drills-46630.json) |

Other runbooks: [list-stock.md](list-stock.md), [testnet.md](testnet.md), [testnet-dry-run.md](testnet-dry-run.md),
[mainnet-launch.md](mainnet-launch.md) (§3: `scripts/mainnet-launch.sh`, the only launch path),
[list-receipt-market.md](list-receipt-market.md) (G5, launch + 30 days), [testnet-smoke.md](testnet-smoke.md).

## Roles and who signs

| Role | Holder (mainnet, [mainnet-launch.md](mainnet-launch.md)) | Can do, instantly | Cannot do |
|---|---|---|---|---|---|
| Guardian | 2-of-4 multisig (Safe) | `oracle.trip/clear(MANUAL, DEVIATION, L2_GAP)`, `oracle.raiseBufferFloor`, vault sentinel: `deallocate`, decrease caps, `revoke` | Lower the floor, change params, touch the router |
| Owner | 4-of-7 multisig → `TimelockController` (48h; 24h on testnet) | Everything below, after the delay | Anything instantly |
| — via timelock | | router `delistMarket`, `setGlobalCap`, `setCapOverride`, `setAttestationSigner`, `setSwapTarget`, upgrade; oracle `clearMultiplierGuard`, `resetReferences`, `setParams`, `setBufferFloor`, `setSequencerFeed`; `MarketHours.replace*From` | |
| Allocator | keeper EOA + multisig | Vault V2 `allocate` / `deallocate` | Caps, fees |
| Guard keeper | keeper EOA | `trip/clear(DEVIATION, L2_GAP)`, `poke` | `MANUAL` |
| Anyone | – | `oracle.poke()`, Morpho `liquidate`, `clUSDG.unwrap`, `wrapper.unwrap`, vault `forceDeallocate` (penalty 0) | – |

Nothing Stockline holds can pause Morpho, seize funds or block exits (CP-R4). Every response below only **stops new
risk** (guard, liquidity pull, caps, delist) and keeps exits working.

## Conventions used in the commands

```sh
export RPC=<rpc url>            # mainnet 4663 / testnet 46630
export NET=4663                 # key in packages/sdk/addresses.json
A=packages/sdk/addresses.json
addr() { jq -r ".chains[\"$NET\"]$1" $A; }
export ORACLE=$(addr '.stocks.NVDA.oracle') WRAPPER=$(addr '.stocks.NVDA.wrapper') VAULT=$(addr '.stocks.NVDA.vault') \
       ADAPTER=$(addr '.stocks.NVDA.adapter') MARKET_ID=$(addr '.stocks.NVDA.marketId') MORPHO=$(addr '.morpho') \
       ROUTER=$(addr '.router') TIMELOCK=$(addr '.timelock') MH=$(addr '.marketHours') CLUSDG=$(addr '.clUSDG') \
       STOCK=$(addr '.stocks.NVDA.stockToken') FEED=$(addr '.stocks.NVDA.feed') USDG=$(addr '.usdg')
# Market params tuple for Vault V2 adapter calls: (loanToken, collateralToken, oracle, irm, lltv)
MP="($WRAPPER,$CLUSDG,$ORACLE,$(addr '.adaptiveCurveIrm'),770000000000000000)"
MPDATA=$(cast abi-encode "f((address,address,address,address,uint256))" "$MP")   # adapter `data` for (de)allocate
ADAPTER_ID=$(cast abi-encode "f(string,address)" this $ADAPTER)                   # cap id data (VaultV2Ids.adapterId)
```

- **Reads** are `cast call … --rpc-url $RPC`. **Guardian actions** are Safe transactions: build the calldata with
  `cast calldata`, paste it into the Safe UI (to = the target), collect 2 of 4 signatures.
- **Owner actions** go through the timelock:
  `pnpm --filter @stockline/sdk timelock <action> key=value --network $NET --salt "<date> <what>"` prints
  `scheduleCalldata` and `executeCalldata` (to = `$TIMELOCK`) and the operation `id`. The multisig submits schedule,
  waits the delay (`cast call $TIMELOCK "isOperationReady(bytes32)(bool)" <id>`), then submits execute.
- Monitor: `curl $MONITOR_URL/incidents`, `curl $MONITOR_URL/weekends`, `curl $MONITOR_URL/health`.

## Comms (base template)

Status page / X / Discord, within 30 minutes of a P0, 60 minutes of a P1 that affects users:

> **[Investigating | Identified | Monitoring | Resolved] — <market> <short title>** (<UTC time>)
> What happened: <one sentence, facts only>. What it means for you: <borrowers / lenders / nobody>. Exits (repay,
> close, withdraw) <keep working | are affected by the issuer, see below>. New borrowing in <market> is <paused |
> unaffected>. Next update by <time>.

Never promise amounts or timelines for restitution before the post-mortem; never ask users to sign anything.

## Post-mortem (base checklist, within 5 business days of a P0 or a user-facing P1)

- [ ] Timeline from chain data (block numbers, tx hashes) and pages (`/incidents`), in UTC
- [ ] Root cause, and why detection took as long as it did
- [ ] Losses (bad debt, stuck funds) per market and who bears them (lenders, backstop from Phase 5)
- [ ] Parameter changes proposed (caps, σ/z, buffers, LLTV for a new market) with sim evidence
- [ ] Runbook and monitor rule updated; drill scheduled on testnet
- [ ] Published summary (no personal data), linked from the status page
