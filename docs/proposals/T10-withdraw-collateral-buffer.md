# Proposal · T10: 24h buffer check on `withdrawCollateral` with debt (residual (e))

**Status:** proposed, waiting on the owner. No contract change, redeploy or timelock scheduling has been made.
**Finding:** [testnet-issues.md T10](../runbooks/testnet-issues.md), residual (e) in [05 §1](../prd/05-collateral-router.md).

## Problem

`StocklineRouter.withdrawCollateral` is an exit, so it has no RT-R1 check. A borrower with debt can withdraw down to
Morpho's LLTV at today's price, below the 24h weekend/earnings buffer. Shown by
[`test_T10_residualE_withdrawLeavesHfAt24hBelowBuffer`](../../contracts/test/router/WithdrawCollateralBuffer.t.sol):
on a Friday at 16:00 ET, a withdrawal leaves HF **1.030 now** and **0.940 at t + 24h**. Morpho accepts it, and the
position becomes liquidatable once the weekend buffer is in force. That hits lenders' liquidation margin at the worst
time (market closed, no hedge).

## Proposed change (router v-next, UUPS)

```solidity
function withdrawCollateral(address stock, uint256 amount, address receiver, uint256 deadline) external nonReentrant beforeDeadline(deadline) {
    Market storage m = _configured(stock);
    if (amount == type(uint256).max) amount = MORPHO.position(m.params.id(), msg.sender).collateral;
    if (amount == 0) revert ZeroAmount();
    MORPHO.withdrawCollateral(m.params, amount, msg.sender, address(this));
    // T10: with debt left, the position must stay healthy through the 24h buffer (zero debt exits freely).
    if (MORPHO.position(m.params.id(), msg.sender).borrowShares != 0) {
        uint256 hf = healthFactorAt(stock, msg.sender, block.timestamp + HORIZON);
        if (hf < 1e18) revert HealthTooLow(hf);
    }
    CL_USDG.unwrap(amount, receiver);
    emit CollateralWithdrawn(msg.sender, stock, amount, receiver);
}
```

- **Threshold 1.0, not 1.10.** 1.10 is the *entry* bar (RT-R1). An exit only needs to stop a borrower making themselves
  liquidatable inside the horizon. 1.0 does that and still lets a healthy borrower take out excess collateral. If
  you prefer 1.10 (`HF_MIN_OPEN`), it is a one-constant change with the same size; the test then uses a 1.10 target.
- **Zero debt stays free.** No oracle read, same gas as today, so the full exit is never blocked.
- **Never blocks on a tripped guard.** `priceAt` never reverts on feed or guard conditions (OR-R2), so exits stay
  open under a trip (CP-R4). The check rejects only a withdrawal that itself breaks the buffer.
- **ABI unchanged** (`HealthTooLow(uint256)` already exists), so the SDK, indexer and web need no changes. The web
  already maps `HealthTooLow`.

**Measured locally** (applied to a working copy, then reverted; nothing committed):
- `StocklineRouter` runtime grows by 307 bytes (24,092 → 24,399), leaving 177 bytes of EIP-170 margin, down from 484.
- The skipped `test_T10_proposed_withdrawCollateralChecksHfAt24h` passes.
- The residual test fails with `HealthTooLow(0.9396e18)`, as intended; it would be flipped to `expectRevert` in the fix commit.
- Every other `test/router/*` suite passes.

**Not closed by this change.** Morpho-direct `withdrawCollateral` bypasses the router. That part is covered by
detection only: the monitor rule `COLLATERAL_BELOW_BUFFER` (MON-R26, P2, [runbook](../runbooks/collateral-below-buffer.md)) pages on both paths.

## Upgrade path

1. Branch `fix/T10-withdraw-buffer`. Commit the router change and flip the tests: drop the `vm.skip`, and the
   residual test becomes `expectRevert`. Then the full quality bar
   ([fix-workflow §3](../audit/fix-workflow.md): fmt, `forge test`, slither, coverage ≥ 95%, `forge build --sizes`,
   `pnpm -r …`), and `StocklineRouterUpgrade.t.sol` extended for the upgrade (state kept, new check live).
2. Deploy the new implementation (no proxy change). The owner (timelock) schedules
   `upgradeToAndCall(newImpl, "")` on the router proxy. The delay is **24h on testnet 46630** (`getMinDelay()` =
   86,400 on `0x4A30…2F82314`) and **48h on mainnet** (RT-R7). The monitor pages the schedule (MON-R16,
   `governance-change.md`).
3. Execute after the delay, re-run `VerifyRoles`, and record it in the launch log. Rehearse on 46630 first
   (`testnetBreak.ts` X group: the T10 simulation then expects `HealthTooLow`).

## Effect on the audit freeze

`StocklineRouter.sol` is frozen at `docs/audit/FREEZE` (`84bfc62`). This is a post-freeze change to an audited
function:
- It goes in README §8.3 "Post-freeze diff" (file · commit · why · test) as its own finding ID (e.g. `INT-T10`).
- The auditor re-reviews `git diff $(cat docs/audit/FREEZE) <fix> -- contracts/src/StocklineRouter.sol` (about +5
  lines) before mainnet.
- It also spends 307 of the 484 bytes of router headroom. Any later router fix would have to fit in 177 bytes, or
  first move code out (for example to a library).

The alternative is to **accept** residual (e) as a known issue (README §7) with detection only: the monitor rule, plus
the app, which offers withdrawal only at zero debt. Then no freeze impact, but the router path stays open.

## Decision needed

Approve (threshold 1.0 or 1.10) → I prepare the fix commit and the testnet timelock schedule for your signature, or
accept as a known issue with detection only.
