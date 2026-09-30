# 08 · Delta-neutral vault

**Phase 4, gated on simulation.** Users deposit USDG. The vault buys Stock Tokens, lends most of them through `rSTOCK`,
and shorts the same notional on a perp venue. Depositors earn lending fees plus funding, paid in USDG, with near-zero stock
price exposure. It is also Lendora's biggest natural lender.

## Scope

In: `DeltaNeutralVault` (ERC-4626 + async withdrawals), strategy manager contract, perp adapter, NAV reporter, rebalancer
keeper, backtest/sim, risk limits.
Out: building a perp venue. v1 of the vault uses one venue.

## Position structure

For a deposit of `D` USDG into a single-stock sleeve with perp leverage `L` and cash buffer `c`:

```
spot notional   S = D · (1 − c) · L / (L + 1)        // bought on DEX, wrapped, deposited into rSTOCK
perp margin     M = D · (1 − c) / (L + 1)            // posted to perp venue, short S notional
cash buffer     C = D · c                            // idle USDG for withdrawals and rebalancing
```

Launch defaults: `L = 3`, `c = 5%`. Of the spot, `LEND_RATIO = 90%` goes into `rSTOCK`. The rest stays wrapped for fast
unwinds. Sleeves: SPY 50%, NVDA 25%, AAPL 25% (placeholder; set by sim).

Yield = lending APY on 90% of S + funding on S (positive when longs pay shorts) + USDG yield on C − swap and rebalance costs − fees.

## Requirements

| ID | Requirement |
|---|---|
| DN-R1 | ERC-4626 over USDG for deposits. Withdrawals are instant up to the cash buffer, then async via an ERC-7540-style request queue settled within 72h or next US market open, whichever is later. |
| DN-R2 | Delta band: absolute net delta per sleeve ≤ 2% of sleeve NAV. The rebalancer trades to 0 when breached and at least once per US trading session. |
| DN-R3 | Perp margin ratio stays ≥ 2× the venue maintenance margin. The rebalancer tops up from the cash buffer, then by redeeming `rSTOCK` and selling spot. |
| DN-R4 | NAV = USDG cash + spot (Chainlink feed price, already multiplier-adjusted (D1); no buffer) + `rSTOCK` value + perp equity. Perp equity comes from a signed NAV report (venue API or onchain read [VERIFY]). A report that changes NAV by more than 1% vs the onchain estimate needs a second signer. *(Task 18: so does a single-signed report once the single-signed moves since the last co-signed report add up to more than 1%, `NavOracle.unconfirmedMoveBps`.)* |
| DN-R5 | Deposits and withdrawals are paused while the market is closed *and* NAV relies on stale perp data older than 15 minutes. The vault never mints or burns shares on a stale NAV. |
| DN-R6 | Per-sleeve cap and total cap, both set by the curator through the timelock. Launch total cap: $2M. |
| DN-R7 | Funding kill switch: if 7-day average funding is negative beyond the lending APY for 72h, the sleeve unwinds to USDG. |
| DN-R8 | Liquidity guard: the vault never lends so much that `rSTOCK` idle liquidity cannot cover the vault's own emergency unwind of that sleeve within 24h. The sim sets `LEND_RATIO` per sleeve. |
| DN-R9 | Fees: 10% performance fee on net yield above a high-water mark, paid to `FeeSplitter`. No management fee at launch. |
| DN-R10 | Roles: the strategy operator can only trade within limits (allowlisted DEX, venue, sleeves, bands). It cannot withdraw to arbitrary addresses. Perp venue withdrawals return only to the vault. |
| DN-R11 | Dashboard in app: NAV per share history, yield split (lending / funding / buffer), current delta, margin ratio, perp venue exposure. |
| DN-R12 | *(Phase 4 sim finding, task 13 §4.1)* While the stock feed session is closed the vault neither mints nor burns (deposits pause, instant withdrawals wait; requests are always accepted and settle after the reopen): spot would be marked at a frozen feed while the perp marks live (a +20% weekend move reads −14.5% NAV). |
| DN-R13 | *(Proposal, sim §4.2)* The kill switch trigger (DN-R7) is configurable (window, hours); a 24 h average below −lending APY for 24 h keeps the −100% APR funding week inside the 2% bound, the 08 default (7-day / 72 h) does not. Risk owner picks. |
| DN-R14 | *(Phase 4 task 14, invariant finding)* Between NAV reports the short leg is marked to the Chainlink price move since the report with the reported short sizes, so share prices stay hedged; a perp trade sent through the strategy makes the NAV stale until a report that has seen it (`tradeNonce`). |

## Weekend behavior

- Perps may keep trading on weekends while Stock Token mint/burn is paused and the oracle is frozen. The vault marks spot
  at Chainlink but keeps extra margin: during closures the margin target becomes 3× maintenance.
- No rebalancing trades on the spot side while the market is closed, unless the perp margin ratio falls below 1.5×.
- Withdrawal queue settlement waits for the next open (DN-R1).

## Simulation gate (must pass before build is scheduled)

1. Backtest ≥ 12 months of perp funding, borrow utilization and spot/perp basis for each launch stock on the chosen venue.
2. Show net APY distribution (p5, p50, p95) after costs, and max drawdown including weekend gaps and perp liquidation cascades.
3. Stress: +20% gap at Monday open, funding at −100% APR for 1 week, perp venue halts withdrawals for 72h, `rSTOCK` utilization at 100% for 48h.
4. Pass criteria: p5 APY > 0, max drawdown < 2% in all stresses except venue failure, and venue failure loss bounded by the perp margin share.

## Open questions

- Which perp venue(s) list these stocks with enough depth, and can a contract hold a margin account there? Lighter's Robinhood Chain instance lists SPY, NVDA and AAPL perps with public hourly funding history and trades on weekends; Arcus lists stock perps (details unconfirmed) (verified Phase 0, 2026-09-26). Contract-held margin accounts: **supported per Lighter's docs** (onchain `changePubKey`, secure withdrawals only to the owning address; Phase 4 task 12, [`docs/phase4/01-perp-venue.md`](../phase4/01-perp-venue.md), A39–A41), with [VERIFY] on EIP-1271 handling and a live canary. Funding history starts 2026-06-26 (≈ 94 days), short of the 12 months the gate needs.
- Is the vault share itself a security in target jurisdictions? Legal review required before launch.
- Should vault shares be accepted as `clUSDG` backing ("own vault shares as collateral" in the roadmap)? Not before 90 days of clean operation.

## Acceptance criteria

- [ ] Sim report meets the gate above and is signed off. *(Phase 4 task 13: verdict **INSUFFICIENT DATA**, 94 days of
  Lighter funding; [report](../../sim/reports/phase4-dn-vault.md), [sign-off sheet](../owner-actions/dn-vault-signoff.md).
  Risk owner.)*
- [x] Fork tests: deposit, rebalance, instant and queued withdrawal, funding kill switch, perp margin top-up.
  *(Task 17: [`DnVault.fork.t.sol`](../../contracts/test/fork/phase4/DnVault.fork.t.sol) 6/6 on a 4663 fork at `latest`:
  lifecycle through the live UniversalRouter, feeds and rSTOCK vault, margin top-up, and 4 stresses; the perp side is
  the mock venue, since no production adapter exists yet.)*
- [ ] 30-day testnet or small-cap mainnet run with delta held inside the band ≥ 99% of the time. *(Engineering
  rehearsal only: a seeded 7-day keeper week on anvil with real Lighter funding, 100% of 1,008 sleeve-ticks in band,
  `keepers/test/dnWeek.test.ts`. The real run needs the testnet go, and a cap > 0 from the owner.)*
- [ ] Separate audit of vault and strategy contracts. *(Package ready: [`docs/audit/phase4`](../audit/phase4/README.md),
  1,022 nSLOC, freeze `6dc13f3`. Owner books the firm.)*
