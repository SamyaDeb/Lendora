# 09 · Fee split and backstop pool

**Fees: Phase 3. Backstop: Phase 5.** Borrowers pay interest set by Morpho's AdaptiveCurveIRM. Lenders keep ~90%. The
other ~10% is taken as the `rSTOCK` vault performance fee and split between the backstop (~5%) and treasury (~5%).

## 1. Fee flow

```
borrow interest (in wNVDA) ──► Morpho market ──► rNVDA vault
                                                   ├─ 90% stays with lenders (share price rises)
                                                   └─ 10% performance fee, minted as rNVDA shares ──► FeeSplitter
                                                                                                    ├─ 50% → BackstopPool (or treasury until Phase 5)
                                                                                                    └─ 50% → Treasury
FeeConverter keeper: redeem rNVDA → unwrap → swap NVDA → USDG → forward (optional per recipient)
```

Note on "all fees in USDG" (litepaper §5): interest accrues in the stock, not USDG. Lenders earn in the stock they lent. The
protocol's share is converted to USDG by the fee converter. The app shows lender yield in both units.

| ID | Requirement |
|---|---|
| FE-R1 | Each `rSTOCK` vault sets `fee = 10%` and `feeRecipient = FeeSplitter`. Changes go through the vault timelock. |
| FE-R2 | `FeeSplitter` holds recipients and weights (bps, sum = 10,000). `distribute(token)` is permissionless. Weights change only through the owner timelock. |
| FE-R3 | Until `BackstopPool` is live, the backstop share goes to a segregated `BackstopReserve` address (multisig), not to the treasury, so it can seed the pool. |
| FE-R4 | `FeeConverter` swaps weekly or when the balance is > $1k, only during market hours, with max slippage 1% via allowlisted aggregators. |
| FE-R5 | The indexer tracks fees earned per market per day. `/v1/protocol/revenue` exposes it. |

## 2. Backstop pool (Phase 5)

Stakers deposit USDG and absorb bad debt first, before lenders. In return they earn the backstop fee share.

| ID | Requirement |
|---|---|
| BS-R1 | `BackstopPool` is ERC-4626 over USDG. Withdrawals have a 14-day cooldown, so capital can't flee ahead of a known loss. |
| BS-R2 | When a Morpho `Liquidate` event reports `badDebtAssets > 0` for a Stockline market, a `cover(marketId, amount)` call by the guardian (with a 24h challenge window) uses backstop USDG to buy the stock and supply it back into the `rSTOCK` vault. This restores lender value. |
| BS-R3 | Cover per event is capped at 30% of pool assets. Larger losses are split pro-rata with lenders, and the app says so upfront. |
| BS-R4 | Target pool size ≥ 5% of total borrowed USD. When below target, the backstop fee share increases to 7.5% (lenders 87.5%) until the target is reached. |
| BS-R5 | Stakers see APY, cover history and current coverage ratio (`pool assets / borrowed USD`). |

## 3. Governance token (later)

Out of scope for this PRD. A token would be considered only after sustained real revenue and legal review. It would
govern stock listings and risk parameters and be stakeable as first-loss capital, replacing or supplementing BS-R1.

## Acceptance criteria

- [ ] Fork test: 30 days of accrual → fee shares minted → split → converted to USDG with correct amounts.
- [ ] Backstop: simulated bad-debt event covered and the `rSTOCK` share price restored to the pre-event value within 1 tx.
- [ ] Revenue endpoint matches the sum of onchain fee transfers.
