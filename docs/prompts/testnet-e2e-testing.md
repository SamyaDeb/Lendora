We're building Lendora, a stock lending layer for Robinhood Chain on unmodified Morpho Blue and Morpho Vault V2.
Phases 0–2 and the remediation are done, and **Lendora is deployed on Robinhood Chain testnet (chain id 46630)**
since 2026-09-28 (349 txs, 50 contracts, smoke flows 13/13; `packages/sdk/addresses.json` → `chains["46630"]`).

This session **tests the testnet product the way real users and operators will use it**: every backend service
running on this machine against the testnet, the web app driven end to end like a user, and failure scenarios drilled
on-chain. **Every issue found gets triaged, fixed with a regression test, and re-verified**, until the product is
ready for the two testnet weekends and external testers.

## 1. Current state (verified 2026-09-28, re-check at start)

| | |
|---|---|
| Deployment | `chains["46630"]` in `packages/sdk/addresses.json`; `startBlock` 125546499; router proxy `0x8233…5C0B` (owner = 24h timelock `0x4A30…2314`); lens, liquidator, `MarketHours`, `clUSDG`, own Morpho Blue / AdaptiveCurveIrm / Vault V2 factory; mocks (3 Stock Tokens, USDG, feeds, pools, swap aggregator, registry, faucet) |
| Roles | One testnet key `0x3394d7Be60302c9649c6E5A3c7fC7b989f521348` holds owner (via timelock), curator, allocator, guardian, guard keeper, mock operator (A27, A28) |
| Oracles | `guardReasons() = 0` for SPY, NVDA, AAPL |
| **Gas** | Deployer has **~0.0084 ETH**: too little for keepers + feed mirror + tests for long. Deploy lessons: `--gas-estimate-multiplier 200` (L1 data fee), load-balanced RPC nodes lag (retry), see `docs/runbooks/testnet.md` deployment record |
| Local | Postgres and Redis are up; **no service is running**; `scripts/dev.sh` has **no testnet mode** (it refuses non-31337) |
| RPCs | Repo-root `.env` (gitignored): `ROBINHOOD_TESTNET_RPC_URL` (Alchemy), `ROBINHOOD_MAINNET_READ_RPC_URL` (read-only, feed mirror), `SEPOLIA_RPC_URL`. Load with `set -a; . ./.env; set +a` |
| Bridge (gas top-ups) | Sepolia Delayed Inbox `0xF2939afA86F6f933A3CE17fCAB007907B6b0B7a4`, `depositEth()` payable (its `bridge()` = `0x96295BDad104eaD97cC08797b3dC68efF59CcF30`); deposits land in ~10–20 min |

## 2. Secrets (the owner sets these; the session only uses the variable names)

Before starting the session, the owner exports in the shell:

- `TESTNET_DEPLOYER_KEY`: the testnet operator key (all roles above).
- `COMPLIANCE_SIGNER_KEY`: the compliance signer key (the router's attestation signer).
- `PROXY_SECRET`: `openssl rand -hex 32`.

The session **never prints, logs, echoes, writes to a file, or commits a key or secret**, and never reads key files.
Services receive keys only through these env vars (`keepers/src/common/signer.ts` reads `<PREFIX>_KEY`). If a
variable is missing, stop and ask the owner to export it.

**Test user wallets**: the session may generate fresh throwaway wallets for simulated users (viem
`generatePrivateKey`), kept only in process memory or in `.dev/testnet-users.json` (`.dev/` is gitignored, mode 600),
funded with a little testnet ETH from the operator key and with mock tokens from the faucet. They hold nothing of
value and are never used anywhere else.

## 3. Read first

1. `docs/runbooks/testnet.md` (tester flows §1, operator deploy + deployment record §2, weekend watch §3),
   `docs/runbooks/README.md` and every P0/P1 runbook, `infra/README.md` (services, env per service)
2. `docs/prd/06-web-app.md` (screens, states, preview panel, APP-R1…R11), `05-collateral-router.md` (flows, RT-R1…R8),
   `07-short-interest.md` (API, SI-R*), `10-risk-compliance.md` (CP-R*, MON-R*), `03` §4 (allocator), `04` §4 (guards)
3. Code: `scripts/dev.sh`, `packages/devnet` (chain driver, `drive smoke`), `web/e2e/{stack,flows.spec,global-setup}.ts`,
   `web/lib/{wagmi,env,complianceProxy,errors}.ts`, `keepers/src/*`, `compliance/src/*`, `api/src/*`, `indexer/src/*`,
   `contracts/test/mocks/MockGate.sol`

## 4. Hard rules

- **Never send a transaction to mainnet 4663** (read-only for the feed mirror). Every script checks the chain id: 46630
  (or 11155111 for bridging, 31337 for local tests). Never swap on any DEX; all test assets come from the faucet.
- **Shared state.** Tests change the live testnet (prices through the mock operator gate, guard trips, liquidations).
  After each drill, restore normal state (resume the feed mirror, clear guards, the market back to `open`) and log it.
  Don't drill between Friday 16:00 ET and Sunday 20:00 ET (weekend watch) unless the owner says so.
- **Contracts.** The audit freeze (`docs/audit/FREEZE`) must keep matching `contracts/src`. If a test reveals a contract
  bug: write a failing forge test that reproduces it, **stop and report to the owner** with severity and a proposed fix.
  Don't redeploy contracts or schedule a router upgrade through the timelock without the owner's explicit OK.
  Deploy-script and mock (testnet-only) fixes are allowed with a test.
- **Off-chain fixes** (web, API, indexer, compliance, keepers, SDK, devnet, scripts) are in scope: smallest change,
  failing-first regression test named with the requirement ID, then the fix.
- Quality bar after every fix: `forge test`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test` green. Commit per
  fix or per step with the attribution lines your environment requires, push to `origin/main`, CI must stay green.
- **Another Claude session may work in this repo.** Before each commit: `git fetch`, `git status`; if `main` moved or
  the tree has changes you didn't make, stop and ask.
- Don't create hosting projects, domains or third-party accounts. Don't touch `client/`.

## 5. Steps

### Step 0 · Pre-flight and gas budget

- Tree clean and pushed, latest CI on `main` green, baseline suites green.
- Re-verify §1 on-chain (code at every address, oracle guard reasons, router owner, attestation signer =
  `COMPLIANCE_SIGNER_KEY`'s address, `MarketHours` runway ≥ 14 days, faucet cooldown).
- **Gas plan.** Estimate the daily burn of the running stack (feed-mirror pushes per mainnet round × 4 feeds, guard
  `poke`s, allocator moves, liquidator, plus test traffic) from recent testnet gas prices and the per-tx cost seen in the
  deploy. Report the number. If the operator balance can't cover ~7 days plus this session, ask the owner for Sepolia
  ETH on `0x3394…1348` and bridge it with `depositEth()` (using `TESTNET_DEPLOYER_KEY` on `SEPOLIA_RPC_URL`), or
  pause the feed mirror between drills. Add a `LOW_GAS` rule to the monitor (P1 below 3 days of burn, P0 below 1 day)
  with a test, if it doesn't exist yet.

### Step 1 · Run every backend service locally against the testnet

- Add `scripts/dev.sh --network 46630`: Postgres and Redis only (no anvil, no `DeployLocal`); refuses unless the RPC
  reports chain id 46630; env from `.env` plus the exported secrets; starts, with logs in `.dev/logs/` and a health
  summary at the end:
  indexer (46630 from `startBlock`) + reconcile, API, compliance (`LENDORA_NETWORK=46630`, `PROXY_SECRET`,
  `TRUST_PROXY=true`, sanctions `deny-list`), keepers with `DRY_RUN=false` (allocator, guard, liquidator, alerts,
  feed mirror (mainnet read-only → testnet mock feeds), monitor (console + file pager until a real pager key exists)),
  web (`next dev`, chain 46630).
- `--stop` and `--status` flags. Restart-safe: rerunning doesn't double-start or re-backfill from zero.
- **Local geo** (no Vercel/Cloudflare locally): add `GEO_PLATFORM=static` + `GEO_STATIC_COUNTRY` to
  `web/lib/complianceProxy.ts`, allowed only when `NODE_ENV=development`; it throws in a production build and when
  `VERCEL` or `RAILWAY_ENVIRONMENT` is set. Tests for all three. Compliance stays unchanged (trusts headers only with
  the secret, CP-R8).
- Document it in `README.md` and `docs/runbooks/testnet.md` §2.

### Step 2 · Service-level tests against the testnet

Write them as a re-runnable suite (e.g. `packages/devnet/test/testnet/*.test.ts`, skipped unless
`LENDORA_TESTNET=1`) so they can run again before each weekend. Record results in
`docs/runbooks/testnet-test-report.md`.

| Service | Checks |
|---|---|
| Contracts (reads) | Wiring per market; `healthFactorAt`/`priceAt` equal SDK math at the same block; `backingShortfall() == 0`; `clUSDG` backing ≥ supply; vault caps and relative cap = U_MAX |
| Indexer | Backfill time from `startBlock`; head lag ≤ 20 blocks (SI-R4); positions and totals equal on-chain at the same block (SI-R1/R2); `confirmed` flag follows `finalized` (SI-R3); reconcile 0 diffs (SI-R5) |
| API | Every endpoint in `07 §2` returns 200 with `asOfBlock/asOfTime/confirmed` (SI-R13); `/markets/{symbol}` = lens `snapshot()` at the same block for 3/3 (07 acceptance); history `?format=csv` (SI-R12); `WS /stream` pushes on new blocks; rate limits free vs keyed (SI-R10); SIWE API key issuance on 46630; `/status` shows guard state and lag; `/openapi.json` valid |
| Compliance | Attest OK for an allowed country with the secret; each denial code: `RESTRICTED_REGION` (US, CA, GB, CH, AE), `GEO_UNKNOWN` (no or spoofed header without secret, CP-R8), `DATACENTER_IP`, `SANCTIONED` (deny-list address), `TERMS_REQUIRED`; per-IP and per-wallet rate limit; attestation accepted by the router on 46630 and rejected after expiry or for another wallet (RT-R2) |
| Allocator | Keeps idle ≈ 10% of assets (LM-R30); reacts to a large deposit/withdraw within a few blocks; pulls liquidity on guard trip and in pre-earnings windows (LM-R31); `/health` |
| Guard keeper | Pokes land (`ReferenceUpdated`); DEX TWAP deviation trip/clear against the mock pools (OR-R31); L2 gap detection; `/health` |
| Liquidator | Detects an unhealthy position and liquidates through `LendoraLiquidator` with profit guard; bad-debt path |
| Feed mirror | Testnet mock feed rounds equal mainnet Chainlink rounds (answer, timing) for SPY/NVDA/AAPL/USDG; stops pushing during the real weekend freeze |
| Alerts (APP-R8) | Settings saved via signed message; HF-threshold alert and the 24h/4h pre-ramp weekend warning delivered (console/webhook), < 60 s after the triggering block; no duplicates after restart |
| Monitor (MON-R1…R14) | Each rule fires once and resolves once in step 4 drills; `/incidents`, `/weekends`; keeper liveness via their `/health` |

### Step 3 · User end-to-end tests (as real users do it)

**Automated browser e2e on testnet.** The existing Playwright suite uses a wagmi mock connector bound to an unlocked
anvil account, which doesn't exist on testnet. Add an e2e-only connector that signs locally with a throwaway test-user
key passed through env (`E2E_TESTNET_USER_KEY`), enabled only when `NEXT_PUBLIC_E2E=testnet` in a dev or test build
(never in `next build` for deployment: a test asserts the production bundle contains no e2e connector). Add
`web/e2e/testnet.spec.ts` (separate Playwright project, runs only with `LENDORA_TESTNET=1`) that drives the local web
app against the testnet for these journeys, each with its own funded test user:

1. **New visitor**: markets page loads with live data; wrong network prompt; connect wallet; accept terms (APP-R10).
2. **Lender**: faucet claim → lend NVDA → rSTOCK balance and variable APY shown → partial withdraw → full withdraw,
   including when idle is short (LM-R22 `forceDeallocate` path).
3. **Short seller**: open a short on NVDA (USDG collateral, borrow, sell) → preview panel shows HF now / at next close
   with full buffer / at +10%, liquidation prices, ramp countdown, swap quote, min received → confirm → the resulting
   on-chain position matches the preview within 0.1% (06 acceptance) → add collateral → close the short.
4. **Borrower**: "just borrow" AAPL → repay part by assets → repay all by shares → withdraw collateral.
5. **Rescue top-up** (RT-R8): add collateral to a position with debt works without an attestation; the UI never offers
   it for a wallet without debt.
6. **Alerts user**: set HF and weekend alerts at `/alerts`, receive one in step 4.
7. **Data user**: `/short-interest` dashboard values equal the API; CSV download works.
8. **Restricted visitor** (`GEO_STATIC_COUNTRY=US`): block page shown; `/portfolio` exits (repay, close, withdraw)
   still work; borrow/short impossible (APP-R2, CP-R4).
9. **Guard tripped**: borrow/short disabled with the reason shown, exits enabled (APP-R4, OR-R33).
10. **Error UX**: slippage too tight, expired deadline, insufficient balance, user rejects in wallet, expired
    attestation, `NoDebtPosition`, cap exceeded (`PerAddressCapExceeded`, `GlobalCapExceeded`), `HealthTooLow`: each
    shows the plain-language message from `web/lib/errors.ts` (APP-R3) and the step list shows where it failed.

Also: every page at 360 px width with no horizontal scroll and AA contrast (APP-R9); Lighthouse on `/` and
`/short-interest` against the testnet-backed app (≥ 85); state refresh on each block and after tx (APP-R7).

**Manual checklist for the owner** (write it into the report; the session can't click a real wallet extension):
MetaMask and Rabby on chain 46630, flows 1–10 of `runbooks/testnet.md` §1, one mobile browser via WalletConnect if a
project id is set. Record wallet-specific issues (network add prompt, gas estimation, permit signing, `multicall`).

### Step 4 · Operator drills on the testnet (runbooks rehearsed for real)

For each: announce in the log, pause the feed mirror if the drill sets prices, run, verify the monitor alert, follow
the runbook, restore, and record timings and block numbers. Use the mock operator gate (`MockGate`) and the guardian
role; timelocked actions (24h) are only scheduled if the drill needs them.

| Drill | Expect |
|---|---|
| Price spike on a shorted stock (mock feed) | Position becomes liquidatable → fallback liquidator liquidates within 2 blocks of eligibility (00 metric) → lender whole; `MISSED_LIQUIDATION` does not fire (or fires and resolves) |
| Bad-debt liquidation | `BAD_DEBT` P0 fires; runbook `bad-debt.md` steps work |
| Manual guard trip / clear | Allocator deallocates within a few blocks; new borrow reverts `GuardTripped`; repay/close succeed; clear → re-allocate (03 acceptance) |
| Stale feed (mirror paused past heartbeat + grace while open) | `STALE` reason live, `ORACLE_STALE` P1, buffers hold; resolves on fresh round |
| Sanity band (answer ×1e10, like the launch-week 1e18 incident) | Round rejected, last good answer kept, `SANITY` + `FEED_REJECTED` |
| Issuer pause / oracle pause / wrapper blocked (mock token + registry) | `TOKEN_PAUSED` / `ORACLE_PAUSED` / `WRAPPER_BLOCKED`; UI copy for A25 (stock-side exits revert, USDG exits work) |
| Multiplier change (quiet ≤ 5% and a 4:1 split with/without pause window) | OR-R3 behavior; `multiplier-change.md` |
| `adminBurn` on the wrapper (mock) | `BACKING_SHORTFALL` P0 |
| Direct Morpho borrow by an attested user (RT-R8 residual) | `DIRECT_BORROW` P1 |
| Keeper killed (stop the allocator process) | `KEEPER_DOWN` P1 within 5 min; restart clears it |
| Calendar runway (read-only: compute days left) | `CALENDAR_RUNWAY` would fire at < 7 days; document when the next session push is due |
| Utilization > 95% (large borrow by a test user) | `UTILIZATION_HIGH`; allocator restores the idle reserve |

### Step 5 · Triage and fix loop

Keep `docs/runbooks/testnet-issues.md` as the single issue log: `ID | found in step | severity (P0 blocker / P1 must
fix before testers / P2 fix before mainnet / P3 polish) | component | repro (tx hash or steps) | expected | actual |
status | fix commit | regression test`.

- Fix P0/P1 in this session (off-chain), each with a failing-first test, then re-run the step that found it.
- Contract bugs: repro test + report + stop (see §4).
- Anything needing the owner (accounts, keys, ETH, product decisions): list it, keep going on the rest.
- After fixes: re-run the whole Step 2 suite and the Step 3 Playwright testnet project; both green twice in a row.

### Step 6 · Soak and weekend readiness

- Leave the stack running ≥ 12 h (longer if the session allows) and report: indexer lag p50/p95, API p95 latency,
  WS push delay, alert delivery time, keeper errors, memory growth per service, ETH burned per hour, monitor incidents.
- Weekend readiness checklist (from `runbooks/testnet.md` §3): Friday pre-checks can pass, an open borrow per market
  exists (a test user), `/weekends` will record the closure, the machine must stay awake (or hosting is needed; say so),
  enough ETH for the weekend.

### Step 7 · Report and hand over

- `docs/runbooks/testnet-test-report.md`: pass/fail per check in steps 2–4 with evidence (tx hashes, block numbers,
  timings), issue counts by severity (found/fixed/open), soak numbers, the owner's manual checklist.
- Update `docs/prd/11-milestones.md` (Phase 2 status), `06`/`07` acceptance boxes that the testnet run now proves,
  `docs/owner-actions/README.md`, `README.md`, and `12-open-questions.md` for new assumptions (A29+).
- Final summary: what works end to end, what was fixed (commits), what's open (with owners), ETH left and burn rate,
  whether weekend 1 can start this Friday, and whether the product is ready to invite the 20 external testers (which
  also needs counsel's sign-off on the terms, CP-R6).
