# Runbook · Calendar push (`CALENDAR_RUNWAY`, MON-R13, P2; and `CALENDAR` guard, OR-R12)

**Trigger.** Fewer than 7 days of feed sessions stored in `MarketHours`, or an earnings window in
`packages/sdk/data/events.json` starting within 30 days that is not onchain. Past the last stored session the oracle
treats the market as closed for 96h and trips `CALENDAR` (OR-R12): new borrowing stops and the buffer ramps to the
maximum closure buffer.

**Impact.** Runway alert: none yet — push before it runs out. Missing earnings window: no event buffer and no pre-event
liquidity pull for that print (D5), so an earnings gap can exceed the buffer.

## First 5 minutes

1. `cast call $MH "lastSessionClose()(uint256)"`, `cast call $MH "sessionCount()(uint256)"`;
   events: `cast call $MH "eventCount(address)(uint256)" $STOCK` and `eventAt(address,uint256)`.
2. Regenerate the calendar if needed: `pnpm --filter @lendora/sdk gen:sessions <from> <to>` (NYSE holidays, A9 early
   closes) and update `data/events.json` from the company's IR page (`confirmed: true`, A10). Commit.
3. Build the timelock operation (below). Timelock is 48h: push at least 3 days before it is needed.

## Decision tree

- Append sessions: `fromIndex = sessionCount()`, sessions = the generated ones after `lastSessionClose`.
- Replace future sessions (a new holiday): `fromIndex` = index of the first session that has not opened yet.
- Earnings: append (`fromIndex = eventCount(stock)`) or replace a not-yet-started window with the confirmed time
  (`replaceEventsFrom` rejects windows that already started).
- Less than 48h left → the calendar will run out: guardian `trip(MANUAL)` ahead of time so the `CALENDAR` trip is not
  the first signal, and push as fast as the timelock allows.

## Commands

```sh
N=$(cast call $MH "sessionCount()(uint256)" --rpc-url $RPC)
LAST=$(cast call $MH "lastSessionClose()(uint256)" --rpc-url $RPC)
pnpm --filter @lendora/sdk timelock marketHours.replaceSessionsFrom fromIndex=$N sessions=sdk:$((LAST+1)) --network $NET --salt "$(date -u +%F) sessions"
E=$(cast call $MH "eventCount(address)(uint256)" $STOCK --rpc-url $RPC)
pnpm --filter @lendora/sdk timelock marketHours.replaceEventsFrom ticker=AAPL fromIndex=$E events=sdk:$(date +%s) --network $NET --salt "$(date -u +%F) AAPL earnings"
```

Rehearsed on anvil: an earnings window pushed through the real timelock (`runbooks.test.ts`); the runway and missing-
event alerts fire and resolve on truncate / re-push (`monitor.test.ts`).

**Who signs.** Owner 4-of-7 via the timelock. Ops prepares the calldata; Risk confirms event dates and buffers.

## Comms

Earnings windows are announced 48h ahead on the status page ("NVDA borrow buffer rises to ≥ 10% from <time>").

## Post-mortem

Only if the calendar ran out or an earnings window was missed: why the P2 was not acted on in time.
