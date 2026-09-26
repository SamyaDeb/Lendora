# Phase 0 · Validation outputs

Brief: `docs/prompts/phase0.md` (local, not committed). Collected 2026-09-26/27. Start with the memo.

| # | Output | Workstream | What it answers |
|---|---|---|---|
| ★ | [GO-NO-GO.md](GO-NO-GO.md) | WS-G | Recommendation, critical checks, open items, launch parameters |
| 01 | [01-chain-facts.md](01-chain-facts.md) | WS-A | Network, Morpho, Stock Tokens (admin powers, ERC-8056), Chainlink, USDG, DEXs, perps, liquidators, with evidence |
| – | [`packages/sdk/external-addresses.json`](../../packages/sdk/external-addresses.json) | WS-A | Third-party addresses by chain id (typed: `getExternal()`) |
| 02 | [02-fork-validation.md](02-fork-validation.md) | WS-B | Fork tests → question → result → block; log in [evidence/fork-run.log](evidence/fork-run.log); tests in [`contracts/test/fork/phase0/`](../../contracts/test/fork/phase0/) |
| 03 | [`sim/reports/phase0-weekend-gaps.md`](../../sim/reports/phase0-weekend-gaps.md) | WS-C | Feed pattern, weekend/overnight gaps, σ and buffers, premiums, depth, liquidation profitability, borrow demand; code in [`sim/phase0/`](../../sim/phase0/) |
| 04 | [04-prd-decisions.md](04-prd-decisions.md) | WS-D, WS-E | Decisions D1–D10 with options and recommendations; **awaiting approval** |
| 05 | [05-interview-kit.md](05-interview-kit.md), [outreach-tracker.csv](outreach-tracker.csv) | WS-F | Interview guides, scoring rubric, results template |
| 06 | [06-legal-questions.md](06-legal-questions.md) | WS-G | Questions for counsel |
| – | [`../prd/12-open-questions.md`](../prd/12-open-questions.md) | Finish | Checklist ticked with evidence links |

Running things again: fork tests need `ROBINHOOD_RPC_URL` (archive for the pinned block; see 02). Data pulls:
[`sim/phase0/README.md`](../../sim/phase0/README.md).
