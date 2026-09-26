# Stockline PRD

Product requirements for **Stockline**, the stock lending layer for Robinhood Chain.
Source: [`../LITEPAPER.md`](../LITEPAPER.md) (draft v0.1, September 2026).

*As of 2026-09-26. Working name. Not investment or legal advice.*

## How to use these docs

Build in the order of [`11-milestones.md`](11-milestones.md). Each feature PRD has the same shape:
**Summary → Scope → Requirements (numbered, testable) → Contract/API interfaces → Acceptance criteria → Open questions.**
Requirement IDs (e.g. `LM-R3`) are stable. Reference them in commits, tests and issues.

Anything marked **[VERIFY]** is an assumption about Robinhood Chain, Stock Tokens, Chainlink or Morpho deployment
that Phase 0 must confirm before code depends on it (see [`12-open-questions.md`](12-open-questions.md)).

## Index

| # | Doc | Covers | Phase |
|---|---|---|---|
| 00 | [Overview](00-overview.md) | Problem, goals, non-goals, success metrics | all |
| 01 | [Users and stories](01-users.md) | Personas, user stories | all |
| 02 | [Architecture](02-architecture.md) | Components, contracts, offchain services, tech stack, repo layout | 1–2 |
| 03 | [Lending markets](03-lending-markets.md) | Morpho markets where the stock is the loan asset, stock wrapper, rStock vaults | 1 |
| 04 | [Oracle](04-oracle.md) | Chainlink adapter, ERC-8056 multiplier, weekend mode, guards | 1 |
| 05 | [Collateral and router](05-collateral-router.md) | Gated collateral, rStock-as-collateral, one-click router flows | 1 |
| 06 | [Web app](06-web-app.md) | Screens, flows, states, alerts | 2 |
| 07 | [Short-interest data](07-short-interest.md) | Indexer, REST/WebSocket API, onchain lens, dashboard | 2 |
| 08 | [Delta-neutral vault](08-delta-neutral-vault.md) | USDG vault: buy, lend, short perp | 4 |
| 09 | [Backstop and fees](09-backstop-fees.md) | Fee split, fee conversion, backstop pool | 3–5 |
| 10 | [Risk and compliance](10-risk-compliance.md) | Launch parameters, caps, monitoring, geo-restrictions | 1–3 |
| 11 | [Milestones](11-milestones.md) | Build order, deliverables, exit criteria per phase | all |
| 12 | [Open questions](12-open-questions.md) | Phase 0 validation checklist, decisions pending | 0 |

## Key design decisions (summary)

1. **Morpho Blue is the engine.** No custom lending logic. Stockline builds wrappers, an oracle, a router, vaults and data.
2. **Stock is the loan asset.** One isolated Morpho market per stock: loan = wrapped stock, collateral = gated USDG collateral token.
3. **Lenders supply through a per-stock Morpho Vault V2** (ERC-4626, official factory; D6). Its share token *is* the receipt
   (`rNVDA`). The vault enforces supply caps, keeps an idle reserve (relative cap = utilization cap) and takes the protocol fee.
4. **Weekend mode lives in the oracle.** While the 24/5 Chainlink feed is frozen (weekends, holidays) and ahead of
   earnings, the oracle marks the borrowed stock *up* by a volatility-scaled buffer, so borrowers need more collateral. The
   buffer ramps in before the freeze to avoid a liquidation cliff. The feed already includes the ERC-8056 multiplier (D1).
5. **"Pause new borrowing" is done by liquidity, not by a switch.** Morpho Blue borrows are permissionless, so a guard trip
   makes the vault allocator `deallocate` unborrowed liquidity back into the vault. Existing positions and liquidations keep working.
6. **No token at launch.** Fees go to lenders (~90%), backstop (~5%) and treasury (~5%).
