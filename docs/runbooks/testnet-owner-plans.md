# Owner-gated tests on 46630: plans (not run)

Four checks covered on anvil and forks, never on the live chain. Each needs a role key or touches other testers, so
each waits for the owner's OK. Addresses: [`addresses.json["46630"]`](../../packages/sdk/addresses.json). Gas on 46630
is 0.01 gwei: every transaction below costs well under 0.00001 ETH; the operator (`0x3394…1348`, guardian, allocator,
keepers) holds ~0.036 ETH. Tester: `0x8571…8282`.

## 1. Guard trip on NVDA (guardian, immediate, no timelock)

- **Who signs**: the guardian (`roles.guardian` = operator `0x3394…1348`, `TESTNET_DEPLOYER_KEY`), the same call as the
  `guard-trip-clear` live drill ([liveDrills.ts](../../packages/devnet/src/liveDrills.ts)).
- **Calls**: `NVDA oracle 0x3DB7…F1F.trip(1)` (MANUAL) → checks → `clear(1)`. Two transactions.
- **Checks while tripped** (a Playwright case, UI only, with the test wallet): `/stock/NVDA?tab=short` shows “New
  borrowing is paused for this market” with the reason “manual pause by the guardian”, and Review is disabled;
  `/portfolio` still offers Repay, Close and Withdraw on an NVDA position (open a 0.05 NVDA short first); the allocator
  keeper moves NVDA liquidity out within a tick (`/v1/markets/NVDA` supplied falls); the monitor pages `GUARD_TRIPPED`
  (P1) within a minute and resolves after the clear.
- **Effect on other testers**: nobody can open a new NVDA borrow or short for the ~15 minutes it is tripped; lenders
  and exits are unaffected; the allocator moves the liquidity back after the clear.
- **What could go wrong**: the clear fails (key or RPC) and NVDA stays paused → the guardian retries `clear(1)`; the
  allocator does not restore liquidity → it does so on its next tick or by `reallocate` from the allocator role.
- **Undo**: `clear(1)`.

## 2. Liquidation of a tester position

Two ways; I recommend (b): it touches only the tester's own position and uses no feed push.

- (a) A feed push (the feed mirror's owner writes a lower NVDA price): every NVDA position and the vault's hedge see
  it; the guard's deviation check may trip. Not recommended.
- (b) **An edge position before the weekend ramp**: Friday before 16:00 ET, the tester opens a short in the UI with
  health factor ~1.30, then withdraws collateral straight through the router (T10: exits have no buffer check) to a
  health factor of ~1.05 now. The closure buffer ramps in from 16:00 ET (NVDA b_full ≈ 9.6%), so by the 20:00 ET close
  the health factor is below 1.00 without any price move.
- **Who signs**: the tester (open, withdraw, both allowed); the liquidator keeper (operator key) liquidates.
- **Cost**: gas only (< 0.0001 ETH); the tester loses the liquidation incentive on test tokens.
- **Expected**: the liquidator keeper liquidates within a tick of HF < 1.00; `/portfolio` first shows “Can be
  liquidated” (red), then the position is gone and History shows “Liquidated” with the transaction; the monitor records
  the liquidation (and `COLLATERAL_BELOW_BUFFER` paged at the withdrawal, T10); no bad debt (`badDebtAssets = 0`).
- **What could go wrong**: the price moves up during the ramp and HF stays above 1 → no liquidation (retry next week);
  the keeper misses it → anyone can liquidate (fallback). Other testers are not affected.
- **Undo**: none needed; it is the tester's own position.

## 3. Caps (owner = the timelock `0x4A30…2314`, 24 h delay on 46630)

Today: per-address $250k (NVDA default, `capOf(tester, NVDA)` = 250,000e18 WAD USD) and global 4,000,000 USDG
(`globalCap` = 4e12, clUSDG 6 dp); clUSDG supply is 0, so neither can be reached with testnet liquidity.

- **Per address, the tester only** (no effect on anyone else): `router.setCapOverride(tester, NVDA, 200e18)` ($200).
  Calldata `0xc14ea8b6…0ad78ebc5ac6200000` (`cast calldata "setCapOverride(address,address,uint256)" 0x8571…8282
  0x64c2…7F06 200000000000000000000`). Test: a $150 short works, a $250 one is refused with “This borrow would exceed
  the per-address limit for this market.” Undo: `setCapOverride(tester, NVDA, 0)` (0 = the market default), another
  24 h.
- **Global** (affects everyone): `router.setGlobalCap(current supply + 1,000e6)` scheduled at a quiet hour; test that
  an entry above it shows “Lendora's total collateral cap is reached. Try again later.” and exits work; then restore
  `setGlobalCap(4e12)`. Each change pages `TIMELOCK_SCHEDULED` (MON-R16) when scheduled.
- **Calls**: `timelock.schedule(router, 0, data, 0x0, salt, 86400)` by the proposer, then `execute(...)` after 24 h (the
  `timelockOperation` helper in `@lendora/devnet` builds both, as in the `timelock-two-step` drill).
- **What could go wrong**: an execute forgotten → the old value stays (harmless); a global cap set too low blocks
  every tester's new entries until the restore executes (24 h): hence the tester-only override first.

## 4. Weekend 1 (Friday 2026-10-02 20:00 ET close → Sunday 2026-10-04 20:00 ET reopen)

Checklist from [testnet.md §3](testnet.md), with what to look at:

- **Friday before 16:00 ET**: top up the tester (0.0013 ETH left on 2026-10-01; faucet.testnet.chain.robinhood.com);
  a dedicated 46630 RPC for the services and the indexer if possible (T3, T26, T37: the shared public endpoint
  throttles under the full stack); `scripts/dev-testnet.sh --network 46630 --status` all 200; `/v1/status` lag ≤ 20 and
  every market `open`; `curl localhost:42073/incidents` only the known timelock items; at least one open borrow per
  market (open 0.05 SPY/NVDA/AAPL borrows from the tester through the UI so the ramp is observable); dn-rebalancer
  healthy (T26: it now reads funding incrementally).
- **16:00–20:00 ET ramp**: `/v1/markets/<T>/history?interval=1m` `buffer` rises linearly to b_full (SPY ≈ 3.1%, NVDA
  ≈ 9.6%, AAPL ≈ 5.2%); `ramp_4h` alerts at 12:00 ET to wallets with HF at full buffer < 1.2 (the row 14 webhook);
  the session bar reads “Weekend mode starts…” then “ramping”.
- **20:00 ET close, Saturday, Sunday**: no feed rounds; status `closed`; the vault shows “Markets are closed”, deposits
  and instant withdrawals paused, requests still accepted; no `L2_GAP`, no spurious `DEVIATION`; `curl
  localhost:42073/weekends` records the milestones.
- **Sunday 20:00 ET reopen**: the first fresh round releases the buffer; liquidations (if any) succeed; Monday
  morning reconciliation 0 diffs; `DN_QUEUE_OVERDUE` not paged.
- **Rows of `testnet.spec.ts` to run again after the reopen**: 4–6 (lend, withdraw, short: fresh prices and the
  buffer gone from the preview), 9 and 12 (add collateral, close), 16–18 (vault entry and exits after the pause), and
  the break case “stale preview”. Command: `TESTNET_GO=yes SMOKE_KEY=… pnpm --filter @lendora/web exec playwright test
  -c playwright.testnet.config.ts -g "row (4|5|6|9|12|16|17|18)|stale preview"`.
