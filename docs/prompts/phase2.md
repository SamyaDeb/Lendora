We're building Stockline, a stock lending layer for Robinhood Chain (chain id 4663, testnet 46630) built on unmodified
Morpho Blue and Morpho Vault V2. Phase 0 (validation) and Phase 1 (lending core contracts, deploy scripts, keepers) are
complete. This session **builds Phase 2: indexer, API, short-interest lens, web app, alerts, compliance and testnet**,
until every Phase 2 exit criterion that can be met by engineering alone passes.

## 1. Read first (in this order, before writing code)

1. `docs/LITEPAPER.md`, then `docs/prd/README.md`
2. `docs/prd/11-milestones.md` (Phase 1 status + Phase 2 task list), `docs/prd/12-open-questions.md` (D1–D10, A1–A17,
   open questions from Phase 1)
3. The Phase 2 specs: `docs/prd/06-web-app.md`, `07-short-interest.md`, `10-risk-compliance.md` (CP-R1…R7), plus
   `02-architecture.md` (tech stack, repo layout), `05-collateral-router.md` (flows the UI must drive, RT-R2 attestation),
   `03-lending-markets.md` and `04-oracle.md` (what the UI must display: buffers, guard states, caps)
4. `docs/phase0/01-chain-facts.md` (real addresses, testnet RPC/explorer, finality: `safe` ≈ 11.5 min, `finalized`
   ≈ 18 min, ~0.1 s blocks)
5. The existing code:
   - `contracts/src/` — especially `StocklineRouter.sol` (events, `Attestation(address user,uint256 expiry)` EIP-712
     type, `healthFactorAt`), `oracles/StocklineOracleBase.sol` (`GuardChanged`), `MarketHours.sol`
   - `contracts/script/` — `StocklineDeploy.sol`, `DeployLocal.s.sol`, `DeployFork.s.sol`, `ForkConfig.sol`,
     `LocalMocks.sol`
   - `packages/sdk/` — `src/` (math, calendar, abis, addresses), `addresses.json`, `external-addresses.json`,
     `scripts/` (`genSessions.ts`, `genVectors.ts`, `export-abis.mjs`), `data/`
   - `keepers/src/common/` (chain, config, health, loop, signer — reuse these patterns for new services)

Then run the baseline and confirm it:

```sh
cd contracts && forge fmt --check && forge build && forge test
cd .. && pnpm -r typecheck && pnpm -r test
```

Expected (2026-09-27, without `ROBINHOOD_RPC_URL`): **172 Foundry tests pass, 14 fork tests skipped; 47 SDK tests pass;
19 keeper tests pass.** One `keepers/test/guard.test.ts` case has been seen to fail once under a full parallel run and
pass alone (the file takes ~150 s). If it flakes for you, find the cause (probably a timeout) and fix it as task 0.

## 2. Current state (don't redo)

- Phase 1 is done: `StockWrapper`, `BlocklistHolderAllowlist`, `MarketHours`, `StocklineOracle`,
  `ReceiptCollateralOracle`, `clUSDG`, Vault V2 deploy scripts, `StocklineRouter`, `StocklineLiquidator`, allocator,
  guard and liquidator keepers, the full lifecycle fork test. See the status table in `11-milestones.md`.
- `indexer/`, `api/` and `web/` contain only placeholder READMEs. They are already listed in `pnpm-workspace.yaml`.
- `packages/sdk/addresses.json` has keys `31337` (anvil + mocks, incl. `mocks.registry`) and `fork-4663`. There is no
  testnet (`46630`) key yet and **never** a real `4663` key in this phase.
- `FeeSplitter` is a placeholder address in the deploy (the contract is Phase 3 with fees). There is no
  `StocklineRegistry` contract; SI-R21 allows passing the stock list in at deployment.
- `client/` (untracked) is a separate marketing landing page ("lendora"). **Don't touch it and don't build the app
  there.** The product app goes in `web/`, per the PRD. Don't add `client/` to the workspace.
- Open questions from Phase 1 (OR-R3 quiet step, OR-R14 event timing, `openShort` gas, extra aggregators, archive RPC)
  stay open. They don't block Phase 2; don't resolve them unless I answer.

## 3. Hard rules

- **Never broadcast to Robinhood Chain mainnet (4663)**, never sign with a real key, never commit keys or secrets.
- **Testnet (46630) broadcasts only after I say go**, with a key I provide through env (`TESTNET_DEPLOYER_KEY` or a
  hardware/remote signer), never in the repo. Before that, build and test everything on anvil and on an anvil fork.
  If `ROBINHOOD_TESTNET_RPC_URL` isn't set, ask me for it; keep working on the other tasks meanwhile.
- **Contracts stay as they are.** Phase 2 adds only `ShortInterestLens` (and testnet-only faucet/mock contracts if
  needed). Any change to a Phase 1 contract needs a reason, a test and a mention in the task summary. Morpho Blue and
  Vault V2 stay unmodified.
- **One source of truth.** Every address, ABI and every safety number (health factor, liquidation price, buffer, price,
  APR/APY) comes from `@stockline/sdk`. The indexer, API, web app and alerts service import it; nothing re-implements
  the math. If the SDK lacks a function, add it to the SDK (with tests and, where it mirrors Solidity, vectors).
- **Requirement IDs everywhere:** test names (`SI_R13 includes asOfBlock…`, `test_SI_R20_accruesInterest…`,
  `APP-R4 disables short when guard tripped`), code comments at the implementing site, commit messages.
- **Exits are never blocked** (CP-R4, APP-R2, APP-R4): repay, close, withdraw and unwrap must work from the UI for a
  geo-blocked visitor, without an attestation and with the guard tripped. Test this explicitly.
- **No yield promises** in copy (CP-R7). APYs are labeled "variable".
- **Secrets and PII:** the compliance signer key, API keys, email/Telegram tokens come from env through a signer/config
  abstraction. Don't store wallet↔IP links (APP-R11). Store terms signatures (APP-R10) without IP.
- **Stack** (from `02-architecture.md`): Ponder → Postgres; API in TypeScript (Hono preferred) + Redis; web in Next.js
  App Router + wagmi + viem + TanStack Query + Tailwind; Playwright for e2e. Node ≥ 22, pnpm workspace. If you want to
  deviate, ask first.
- **Local dev must run with one command** per service, plus a `docker-compose.yml` (Postgres, Redis, anvil with the
  `DeployLocal` state) so the whole stack runs offline. Reuse `keepers/test/fixtures/anvil-state.hex` or regenerate it.
- **Quality bar per task:** `pnpm -r typecheck`, `pnpm -r lint` (add eslint where missing), `pnpm -r test` green;
  contracts rules from Phase 1 still apply to the lens (fmt, ≥ 95% line coverage, no slither medium+). Extend CI
  (`.github/workflows`) with jobs for every new package.
- **Commit after each task** (`feat(indexer): Ponder indexer SI-R1…R5 (Phase 2 task 1)`) with the attribution lines
  your environment requires.
- **Ask, don't guess** when the PRD is ambiguous or contradicts the code; propose the PRD edit and keep going on other
  tasks while you wait. Record new engineering assumptions in `12-open-questions.md` as A18+.
- Human items (20 external testers, interviews, legal, issuer, Chainlink, Morpho listing, domain names, hosting
  accounts) **don't block** engineering. Build the tooling for them; don't try to resolve them.

## 4. Tasks (in order)

### Task 0 · Baseline and plumbing

- Confirm the baseline; fix the guard-keeper flake if it reproduces.
- Add `docker-compose.yml` (Postgres, Redis, anvil loaded with the local deployment) and a `scripts/dev.sh` (or pnpm
  script) that starts anvil, deploys (`DeployLocal`), writes `addresses.json` and starts the services.
- A local "chain driver" script (TS, in `packages/sdk/scripts` or `tools/`) that seeds realistic activity on anvil:
  lends, shorts, repays, a liquidation, feed rounds across a weekend (using the mocks), a guard trip. The indexer, API,
  web app and alerts tests all reuse it.

### Task 1 · Indexer (`indexer/`, SI-R1…R5)

- Ponder config per network (`31337`, `fork-4663`, `46630`) reading addresses and ABIs from `@stockline/sdk`.
- Index Morpho Blue events filtered to Stockline market ids, Vault V2 events, router events, oracle `GuardChanged`,
  wrapper multiplier changes (SI-R1).
- Schema: positions (user, market, borrowShares, collateral), per-block market snapshots where state changed, 1m/1h/1d
  rollups, event feed (SI-R2). Compute the §Definitions fields of `07` with SDK math (shares after multiplier, USD at
  `P_wrapped`, utilization, `utilizationVault`, rates net of fee, `siPctFloat`, `borrowers`, 24h flows,
  `marketStatus`). `daysToCover` needs DEX volume: index the Uniswap pools from `external-addresses.json` or mark it
  `null` with a documented reason.
- Reorg safety: a `confirmed` flag driven by the `safe`/`finalized` tags (SI-R3).
- Reconciliation job (SI-R5): compares indexed totals with onchain `market()` reads after accrual; non-zero diff → log
  + alert hook (pager integration is a stub with an interface).
- Tests: run against the task 0 chain driver on anvil; assert indexed state equals onchain state at the same block.
  Measure backfill time and head lag locally and record them (SI-R4 is checked for real on testnet).

### Task 2 · `ShortInterestLens` (`contracts/src/ShortInterestLens.sol`, SI-R20…R21)

- Interface exactly as in `07 §3`. Uses `MorphoBalancesLib.expectedMarketBalances` (accrued to `block.timestamp`).
  Stateless, stock list passed at deployment. Include vault idle (unallocated) assets in `suppliedShares` per the
  `supplied` definition; document if the struct can't carry everything.
- Unit + fork tests; add it to `StocklineDeploy.sol` and `addresses.json`; export the ABI to the SDK.

### Task 3 · Public API (`api/`, SI-R10…R14)

- Hono service over the indexer's Postgres: every endpoint in `07 §2`, `WS /stream` (market and events channels,
  Redis fan-out), `?format=csv` on history (SI-R12), `asOfBlock`/`asOfTime`/`confirmed` on every response (SI-R13),
  `/status` (oracle freshness, guard state, indexer lag).
- Rate limits (SI-R10) with Redis; self-serve API keys via Sign-In with Ethereum.
- OpenAPI 3.1 generated from the route schemas (zod or similar), served at `/openapi.json`; a **typed client generated
  from it** exported by `@stockline/sdk` (`sdk.api.*`).
- Tests: contract tests per endpoint; a test that `/markets/{symbol}` equals lens `snapshot()` at the same block
  (07 acceptance). A load-test script (k6 or autocannon) for 200 WS clients + 50 req/s, run locally and results
  recorded (SI-R11).

### Task 4 · Compliance signer and geo-block (CP-R1…R4, RT-R2, APP-R2, APP-R10)

- A service (inside `api/` as its own route group, or `compliance/` if cleaner) that issues the router's EIP-712
  `Attestation(user, expiry)` with 24h validity after: IP country check against a **config** list (CP-R1), a sanctions
  screen behind an interface (Chainalysis/TRM adapter stubbed, deny-list implementation for tests), and a stored terms
  signature (APP-R10). Signer key via the keepers' signer abstraction.
- Datacenter/VPN heuristic for borrow flows (CP-R2) behind an interface with a static-list implementation.
- Tests: the attestation verifies on the deployed router (anvil); expired/wrong-signer rejected; exits need none.

### Task 5 · Web app (`web/`, APP-R1…R11, 06 screens)

Build in this order: **Markets `/` → `/market/[symbol]` → Lend → Short → Portfolio → `/short-interest` → `/alerts`.**

- wagmi (injected, WalletConnect, Coinbase Wallet), chain config for 31337 / 46630, wrong-network prompt (APP-R1).
- Edge middleware geo-block with exits always reachable (APP-R2).
- Every tx: step list, `eth_call` simulation first, decoded revert reasons in plain language (APP-R3).
- Guard tripped → Borrow/Short disabled with the reason, exits enabled (APP-R4). Lists/charts from the API, the user's
  positions and the preview from chain multicall (APP-R5). HF colors (APP-R6). Refresh on each block / 5s / after tx
  (APP-R7). Accessibility AA and 360px (APP-R9). Terms + "not an offer of securities" footer (APP-R10). Privacy-safe
  funnel analytics without wallet↔IP (APP-R11).
- The Borrow/Short preview panel shows every item in `06 §Preview panel`, all computed by the SDK (HF now / at next
  close with full buffer / at +10%; liquidation price now and during closure; ramp-in countdown; swap quote with price
  impact and min received; manufactured-dividend note).
- Design every state in `06 §States to design`.
- Tests: component tests; **Playwright e2e on anvil** for every router flow in `05 §4`, including a test that preview
  numbers match the onchain result within 0.1% (06 acceptance); Lighthouse ≥ 85 on `/` and `/short-interest` (script
  it, record results).

### Task 6 · Alerts service (`keepers/alerts`, APP-R8)

- Watches positions from the indexer (API or DB) plus the chain; sends when HF < user threshold, and 24h and 4h before
  ramp-in when HF at full buffer < 1.2 (use SDK `healthFactorAt` + calendar). Channels: email, Telegram, webhook,
  behind a transport interface (real providers wired by env, fake transport in tests). Target < 60s from the triggering
  block; measure it in tests with the chain driver.
- Settings are saved from `/alerts` via a signed message. Same keeper standards as Phase 1 (dry run, `/health`,
  restart-safe, idempotent: no duplicate alerts).

### Task 7 · Testnet readiness (then deployment on my go)

- `DeployTestnet` script path: mocks for the Stock Tokens / feeds / USDG / pools where testnet lacks the real ones
  (check what exists on 46630 first, record findings in `01-chain-facts.md`), 24h timelocks (02 roles), a faucet
  contract or script for mock stocks and USDG, the lens, `addresses.json` key `46630`.
- Dry-run the whole thing on an anvil fork of testnet (or a plain anvil if the fork RPC is unavailable).
- Infra config for indexer, API, keepers, alerts and web (Railway or similar, per `02`): Dockerfiles, env templates
  (`.env.example` per service, no values), health checks. **Don't create hosting projects or deploy services without
  asking me.**
- Tester program kit: `docs/runbooks/testnet.md` (how to get funds, flows to try, how to report bugs), a feedback
  form link placeholder, and a "weekend watch" checklist for the 2 clean testnet weekends.
- Then stop and ask me for the go, the testnet RPC and the deployer key. After I say go: broadcast, verify contracts,
  start the services, run the chain driver's smoke flows against testnet and report.

## 5. Finish (Phase 2 exit criteria, from `11-milestones.md`)

Exit = `06` and `07` acceptance, 2 clean testnet weekends, 20 external testers. The weekends and testers are
human/time-gated, so:

- Check every `06`/`07` acceptance box that engineering can prove, with links to the tests. Mark the rest
  "pending testnet run" or "pending testers" with what's needed.
- Update `11-milestones.md` (Phase 2 status table like Phase 1's), `README.md` status table, `12-open-questions.md`
  (A18+ assumptions, new open questions).
- Final run: `forge fmt --check`, `forge build --sizes`, `forge test` (with and without `ROBINHOOD_RPC_URL`),
  `forge coverage`, slither, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, Playwright e2e, Lighthouse, load
  test. Report the results honestly, including anything skipped, flaky or failing.
- End with a short summary: what's built, test numbers, measured latencies (API p95, WS push, indexer lag, alert
  delivery), Lighthouse scores, open questions for me, and what Phase 3 (audits, guarded mainnet, fees) needs from
  this work.
