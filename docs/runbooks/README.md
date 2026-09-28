# Runbooks

One page per P0/P1 alert of the ops monitor ([10 "Monitoring and paging"](../prd/10-risk-compliance.md#monitoring-and-paging),
MON-R1…R15), plus the operational procedures they share. Every page has the same shape: **trigger → impact → first 5
minutes → decision tree → exact commands → who signs → comms → post-mortem**.

| Alert (rule) | Sev | Runbook | Rehearsed on anvil |
|---|---|---|---|
| `BAD_DEBT` (MON-R1) | P0 | [bad-debt.md](bad-debt.md) | detection: monitor test; response: delist + `repay` ([runbooks.test.ts](../../packages/devnet/test/runbooks.test.ts)) |
| `MISSED_LIQUIDATION` (MON-R2) | P0 | [missed-liquidation.md](missed-liquidation.md) | detection + standard liquidation: monitor test |
| `BACKING_SHORTFALL` (MON-R3) | P0 | [wrapper-backing-shortfall.md](wrapper-backing-shortfall.md) | detection (`adminBurn`): monitor test; delist: runbooks test |
| `CLUSDG_BACKING` (MON-R4) | P0 | [usdg-freeze.md](usdg-freeze.md) | detection (USDG wipe): monitor test; delist: runbooks test |
| `ORACLE_STALE` / `FEED_REJECTED` (MON-R5/R6) | P1 | [oracle-stale-or-rejected.md](oracle-stale-or-rejected.md) | detection: monitor test; re-anchor through the timelock: runbooks test |
| `GUARD_TRIPPED` / `PULL_NOT_EFFECTIVE` (MON-R7/R11) | P1 | [guard-tripped.md](guard-tripped.md) | manual trip → pull → clear: runbooks + monitor tests |
| issuer pause / blocklist (`GUARD_TRIPPED` TOKEN_PAUSED, WRAPPER_BLOCKED) | P1 | [issuer-pause-or-blocklist.md](issuer-pause-or-blocklist.md) | pause → USDG exit → unpause: runbooks test |
| `L2_GAP` (MON-R8) | P1 | [sequencer-l2-gap.md](sequencer-l2-gap.md) | detection: monitor test |
| `KEEPER_DOWN` (MON-R9) | P1 | [keeper-down.md](keeper-down.md) | detection: monitor test |
| `LOW_GAS` / `LOW_GAS_CRITICAL` (MON-R15) | P1 / P0 | [low-gas.md](low-gas.md) | detection (configured and measured burn): monitor test |
| `DIRECT_BORROW` (MON-R10) | P1 | [direct-borrow.md](direct-borrow.md) | detection: monitor test; global cap through the timelock: runbooks test |
| `CALENDAR_RUNWAY` (MON-R13) | P2 | [calendar-push.md](calendar-push.md) | detection: monitor test; event push through the timelock: runbooks test |
| multiplier change (`GUARD_TRIPPED` MULTIPLIER) | P1 | [multiplier-change.md](multiplier-change.md) | latch → confirm through the timelock: runbooks test |

Rehearsals: `pnpm --filter @stockline/devnet test` (runbooks.test.ts, real TimelockController with the calldata from
the SDK tool) and `pnpm --filter @stockline/keepers test` (monitor.test.ts). **Testnet drills** (Phase 3 exit, "runbooks
drilled") are still to do; record them in the table with date and who ran them.

Other runbooks: [list-stock.md](list-stock.md), [testnet.md](testnet.md), [testnet-dry-run.md](testnet-dry-run.md),
[mainnet-launch.md](mainnet-launch.md).

## Roles and who signs

| Role | Holder (mainnet, [mainnet-launch.md](mainnet-launch.md)) | Can do, instantly | Cannot do |
|---|---|---|---|
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
