# 11 · Milestones and build order

Build in this order. Each phase has exit criteria that gate the next. Durations are estimates for a team of 2 Solidity, 2
TypeScript/full-stack and 1 risk/quant person.

| Phase | Focus | Est. | Exit criteria |
|---|---|---|---|
| 0 | Validation | 3 weeks | All [VERIFY] items in [12](12-open-questions.md) answered; 15 borrower interviews; go/no-go memo |
| 1 | Lending core contracts | 6 weeks | [03](03-lending-markets.md), [04](04-oracle.md), [05](05-collateral-router.md) acceptance criteria pass on fork |
| 2 | App, indexer, API, testnet | 6 weeks | [06](06-web-app.md), [07](07-short-interest.md) acceptance; 2 testnet weekends clean; 20 external testers |
| 3 | Audit, guarded mainnet | 6–8 weeks | 2 audits closed; runbooks drilled; mainnet with caps in [10](10-risk-compliance.md); fees live ([09 §1](09-backstop-fees.md)) |
| 4 | Delta-neutral vault | 8 weeks after sim gate | [08](08-delta-neutral-vault.md) sim gate, audit, 30-day run |
| 5 | Backstop, then token later | TBD | [09 §2](09-backstop-fees.md) acceptance; token only with revenue + legal |

## Phase 1 task breakdown (lending core)

Ordered so each task unblocks the next. IDs map to requirements.

1. **Repo scaffold.** Monorepo per [02](02-architecture.md); Foundry with Morpho Blue + Vault V2 submodules; CI (forge test, fmt, slither); `packages/sdk` with addresses and ABIs.
2. **Mocks.** Mock Stock Token with ERC-8056 multiplier, mock Chainlink feed with `updatedAt` control, mock USDG, mock DEX/aggregator.
3. **`StockWrapper`.** LM-R1…R7, invariant tests.
3b. **`StockWrapper` changes (D10 R1–R4).** `backingShortfall()` (LM-R8), `adminBurn` failure-mode test, optional `BlocklistHolderAllowlist` (LM-R6), `IScaledUIAmount` comment.
3c. **Extend mocks (D10 R5).** `oraclePaused()`, per-token and global `paused()`, blocklist reverting `Blocked(addr)`, `adminBurn`; mock sequencer uptime feed; mock Uniswap v3 pool (`observe`).
4. **`MarketHours`.** OR-R10…R14 (feed sessions and event windows), plus `packages/sdk/scripts/genSessions.ts` and `packages/sdk/data/events.json`.
5. **`StocklineOracle` + `ReceiptCollateralOracle`.** OR-R1…R8, OR-R20…R23, OR-R30…R33. SDK `priceAt`, `bufferAt`, `liquidationPriceAt`, `healthFactorAt`, shared test vectors.
6. **`clUSDG`.** CL-R1…R7, Paxos-freeze fork test.
7. **Deploy scripts (Vault V2).** `DeployCore` + `DeployStock`: wrapper → oracle → market → Vault V2 + adapter → caps → fee → roles → timelocks (LM-R10, LM-R20, LM-R22, LM-R23); `addresses.json`; Vault V2 code-hash fork test; `docs/runbooks/list-stock.md`.
8. **`StocklineRouter`.** RT-R1…R7, all flows, fork tests, gas report.
9. **Allocator keeper.** LM-R30…R34 (Vault V2 `allocate`/`deallocate`), pre-earnings pull.
10. **Guard keeper.** OR-R31, OR-R32, OR-R6 (L2 gaps), issuer flags.
11. **Fallback liquidator.** `StocklineLiquidator` (Morpho callback, unwraps `clUSDG`) + bot.
12. **Full lifecycle fork test.** Lend → open short → Friday ramp-in → weekend hold → Monday gap → liquidation → lender withdraws whole; plus earnings event, 1e18 feed incident, issuer pause, `adminBurn`.

## Phase 2 task breakdown

1. Ponder indexer (SI-R1…R5) and reconciliation job.
2. API (SI-R10…R14), OpenAPI spec, typed SDK client.
3. `ShortInterestLens` (SI-R20…R21).
4. Web app screens ([06](06-web-app.md)) in order: Markets → Lend → Short → Portfolio → Short-interest dashboard → Alerts.
5. Alerts service (APP-R8).
6. Compliance signer and geo-block (CP-R1…R4).
7. Testnet deployment, faucet for mock stocks and USDG, tester program.

## Definition of done (any requirement)

- Code merged with tests. Contracts need ≥ 95% line coverage and fuzz/invariant tests where specified.
- The requirement ID is referenced in the test name or PR.
- SDK updated if the math or addresses changed.
- Docs/runbook updated if behavior visible to operators changed.
