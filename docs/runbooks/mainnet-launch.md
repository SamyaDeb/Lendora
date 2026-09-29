# Runbook · Guarded mainnet launch (Phase 3)

The deployment and role checklist for chain 4663. **Nothing here runs without the owner's go**; every box needs a
named person and evidence (tx hash, screenshot, link) in the launch log. Deploy logic: `contracts/script/StocklineDeploy.sol`
(the `_deployCore` / `_deployStock` / `_finalize` steps the fork suite exercises); per-stock steps:
[list-stock.md](list-stock.md).

## 0. Gates (all must be ✅ before the deploy transaction)

Status per gate (engineering done vs. waiting on a person): [11 · Mainnet-readiness checklist](../prd/11-milestones.md#mainnet-readiness-checklist-gates-of-mainnet-launchmd-0-and-what-14-need).
The boxes below are ticked only by the people who close them.

- [ ] Two audits closed; every finding fixed or accepted in writing; fixes re-reviewed against the freeze
      ([`docs/audit`](../audit/README.md)).
- [ ] Counsel opinions (06 legal questions A–D) and terms of use / risk disclosure signed off (CP-R6).
- [ ] Sanctions provider contracted and live: `SANCTIONS_PROVIDER=chainalysis|trm`, `SANCTIONS_API_KEY` in the secret
      store (Q5). The compliance service refuses to start on 4663 with the deny-list (CP-R8).
- [ ] Risk owner signed off the sim report (σ, z, event buffers, caps; 04 acceptance) and the weekday DEX depth run.
- [ ] 2 clean testnet weekends (`GET /weekends` evidence) and 20 external testers (Phase 2 exit).
- [ ] Runbooks drilled on testnet: at least guard-tripped, oracle re-anchor, calendar-push, multiplier-change,
      keeper-down, and one P0 tabletop (bad-debt or wrapper shortfall); dates in [README.md](README.md). (Rehearsed
      on a fork of 46630, 8/8: [fork-drills-46630.md](fork-drills-46630.md); testnet run waits for "go testnet".)
- [ ] Bug bounty live (e.g. Immunefi), max payout sized to the caps.

## 1. Multisigs and keys (hardware wallets only)

| Role | Setup | Check |
|---|---|---|
| Owner | Safe **4-of-7**, signers on hardware wallets, ≥ 3 organizations or independent people | `getThreshold() == 4`, `getOwners().length == 7` |
| Curator | Separate Safe (≥ 2 signers, e.g. 3-of-5); **not** the owner Safe (MN-R1) | `vault.curator()`; `getThreshold() >= 2` |
| Guardian (= Vault V2 sentinel) | Safe **2-of-4**, on-call rotation covers 24/7 | `getThreshold() == 2`, `getOwners().length == 4` |
| Allocator | Keeper EOA from KMS/HSM (remote signer) **and** the owner Safe as a second allocator | `isAllocator` true for both |
| Guard keeper | Separate KMS key | `oracle.keeper()` per market |
| Liquidator bot | Separate KMS key, funded with USDG working capital | – |
| Compliance signer | KMS key, never exported (`COMPLIANCE_REMOTE_SIGNER_URL`) | `router.attestationSigner()` |
| Deployer | Fresh EOA, used once, then emptied; holds **no** role after `_finalize` | every role check below shows no deployer |

| Treasury, `BackstopReserve` | Two Safes (≥ 2 signers each), owner-provided (Q9) | `FeeConverter.destination()` |
| Fee keeper | Separate KMS key; can only trigger `FeeConverter.convert` | `FeeConverter.keeper()` |

**A27 must not carry over:** on testnet one key held every role; on mainnet **every** `STOCKLINE_*` role is a
distinct address from the table above. `DeployMainnet` refuses otherwise (MN-R1…MN-R3), and the fork test replays the
exact config before broadcasting (§3, step 3).

## 2. Configuration (from D8 and 10 launch parameters)

| Item | Value | Where |
|---|---|---|
| Timelock min delay | **48h** | `TimelockController(48 hours, [owner Safe], [owner Safe], address(0))` |
| Vault V2 timelocks | 48h on every harmful curator action; `increaseTimelock` last | `_lockVault`, `_lockAdapter` |
| Vault caps (USD at listing) | SPY $1M, NVDA $1M, AAPL $250k; **start at 25% of target** (list-stock.md §3) | absolute caps on the 3 adapter ids |
| Relative cap (`U_MAX`) | 90% | market id |
| Per-address debt caps | SPY $75k, NVDA $250k, AAPL $35k | `router.listMarket(…perAddressCapUsd)` |
| Global `clUSDG` cap | $4M | `router.initialize` / `setGlobalCap` |
| Oracle params | σ 17/52/28%, z 2.5, B_MIN 1%, B_MAX 20%, ramp 4h, heartbeat 24h, grace 10 min, band ×0.5–×2, quiet multiplier step 5% | `StockConfig` per stock |
| Event buffers | NVDA ≥ 10%, AAPL ≥ 8% (confirmed dates only, A10) | `MarketHours.replaceEventsFrom` |
| Sequencer feed | `address(0)` (none on 4663; L2_GAP keeper path) | `CoreConfig.sequencerFeed` |
| Swap target | UniversalRouter `0x8876…0904`, `SwapMode.Transfer` (Q4) | router and liquidator |
| Performance fee | 10% → `FeeSplitter` (Phase 3 task) | Vault V2 |
| `forceDeallocatePenalty` | 0 (A12) | Vault V2 |

## 3. Deploy: `scripts/mainnet-launch.sh`, the only supported path

One guarded, resumable command runs every step below in order and stops at the first refusal. It never uses a
private key, never sets `I_HAVE_THE_OWNERS_GO` itself, and never broadcasts without a typed confirmation. The manual
commands it wraps are listed per step for review; do not run them by hand.

```sh
# the operator, after the owner's written go is in the launch log:
export I_HAVE_THE_OWNERS_GO=1
export STOCKLINE_OWNER=0x… STOCKLINE_CURATOR=0x… STOCKLINE_GUARDIAN=0x… STOCKLINE_ALLOCATOR=0x…
export STOCKLINE_GUARD_KEEPER=0x… STOCKLINE_TREASURY=0x… STOCKLINE_BACKSTOP_RESERVE=0x…
export STOCKLINE_FEE_KEEPER=0x… STOCKLINE_ATTESTATION_SIGNER=0x…
export STOCKLINE_DN_OPERATOR=0x… STOCKLINE_NAV_SIGNER_1=0x… STOCKLINE_NAV_SIGNER_2=0x…
export LAUNCH_DEPLOYER=0x… LAUNCH_SIGNER=ledger        # or trezor | aws | gcp (KMS); never a key
export ROBINHOOD_RPC_URL=https://…                    # the real 4663 endpoint (dedicated provider)
scripts/mainnet-launch.sh [--services-env infra/mainnet.env] [--apply]
```

| Step | What it does | Refuses when |
|---|---|---|
| 0 go | `I_HAVE_THE_OWNERS_GO=1` present (set by the operator) | unset (MN-R4) |
| 1 gates + preflight | every entry of [`launch-gates.json`](../owner-actions/launch-gates.json) signed (person, date, evidence); ≥ 5 GB disk; forge 1.5.1, node ≥ 22, pnpm; clean tree on a **tagged** commit; `forge build --sizes` (router ≤ EIP-170); the full offline suite (`forge test`, `pnpm -r test`) | an unsigned gate, a dirty or untagged tree, a failing build or test |
| 2 env | the 12 roles set, addresses, distinct, not the deployer (MN-R1, MN-R8); chain 4663 and **not** anvil; the five Safes read onchain (owner 4-of-7, guardian 2-of-4, curator/treasury/backstop ≥ 2; an EOA is refused, MN-R2); signer is a hardware wallet or KMS and no `*PRIVATE_KEY*`/`MNEMONIC` var exists; deployer ≥ 0.01 ETH and 2 × SEED of SPY, NVDA, AAPL; service secrets present **by name** (with `--apply`) | any of these |
| 3 rehearsal | `forge test` `DeployMainnetForkTest` and `test/fork/phase1/*`, `phase3/*`, `phase4/*` at `latest` (fork block recorded) | a failure or a skip |
| 4 broadcast | prints chain, deployer, roles and caps; the operator types `DEPLOY 4663 <last 6 of the deployer>`; then `forge script script/DeployMainnet.s.sol --broadcast --slow --gas-estimate-multiplier 200 --verify --verifier blockscout …` with the signer flag (the script's MN-R1…R4 refusals stay). `--resume` is added automatically after an interrupted broadcast | the confirmation differs (nothing is sent) |
| 5 verify | `VerifyRoles` from `deployments/4663.json` (every row PASS; table saved to `deployments/4663.verify-roles.md`); explorer verification of every core contract | any FAIL, any unverified contract |
| 6 publish | `addresses.json["4663"]` from `deployments/4663.json` (+ `4663-receipt-<T>.json` later), `deployBlock` → `startBlock`; ABIs re-exported, SDK rebuilt, OpenAPI + typed client regenerated; prints the commit and the tag to make | an invalid deployment file, a different existing 4663 entry |
| 7 services | prints the env of every service from [`infra/mainnet.env.example`](../../infra/mainnet.env.example) (the owner's filled copy via `--services-env`), **monitor first**; with `--apply` and `railway whoami` OK, sets it through the Railway CLI; then a read-only smoke: monitor `/health`, API `/v1/status`, compliance `/health` with a real sanctions provider, web `/` (`MAINNET_*_URL`) | `--apply` without a Railway login, an unfilled value or a missing secret |
| 8 post-launch | reminders: announce 48h ahead, list at 25% caps, first-weekend watch, bug bounty listing, DN caps stay 0 | – |

Progress is recorded in `contracts/deployments/4663.launch.json`: re-running after any stop skips finished steps
(checks 0–2 always re-run). `pnpm --filter @stockline/launch publish-deployment` is step 6 alone.

**Rehearsal (`--dry-run`).** Against a **local anvil fork of 4663** only (the launcher checks chain id, `anvil` and a
local host; `DeployMainnetDryRun` checks `web3_clientVersion` again and refuses `I_HAVE_THE_OWNERS_GO`): unsigned gates
and a dirty tree are warnings, the deployer is impersonated, output goes to `deployments/4663-dry-run.json`, and
publishing writes a **temp copy** of the address book. Rehearsed 2026-09-29 (`packages/launch/test/launch.test.ts`,
`LAUNCH_DRY_RUN_4663=1`): wrong confirmation → nothing sent; deploy on the fork; VerifyRoles 111/111; temp book gets
`chains["4663"]`; the second run resumes with no change. That dry run found a launch blocker, fixed with a test:
VerifyRoles' DN sleeve check compared by index, and the file lists stocks alphabetically.

```sh
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8600 &
ROBINHOOD_RPC_URL=http://127.0.0.1:8600 STOCKLINE_…=… LAUNCH_DEPLOYER=… scripts/mainnet-launch.sh --dry-run --skip-suite
```

## 4. Services before the first deposit

Order matters: **start the monitor before the first governance action** (its governance cursor starts at the head
on the first run, so a `CallScheduled` before it starts is never paged, MON-R16/R17).

- [ ] Compliance: `PROXY_SECRET` (≥ 32 chars) shared with web, `GEO_PLATFORM` set, `TRUST_PROXY=true`, sanctions
      provider live (startup log and `/health` show `chainalysis` or `trm`), `ALLOWED_ORIGINS` = the app's origin; smoke: a direct request with `cf-ipcountry` and no secret →
      `403 GEO_UNKNOWN`.
- [ ] Monitoring on: `SERVICE=monitor` with PagerDuty or Opsgenie, `MONITOR_KEEPERS` listing every keeper, on-call
      schedule set; test page acknowledged end to end.
- [ ] Keepers live (`DRY_RUN=false`, remote signers): allocator, guard, liquidator; alerts service; indexer, API,
      daily reconcile.
- [ ] Calendar runway ≥ 30 days pushed; earnings windows within 60 days pushed (MON-R13 quiet).
- [ ] Status page and comms channels ready; comms templates from [README.md](README.md).

**Service network rules on 4663 (MN-R6).** Every service calls `resolveDeployment` from `@stockline/sdk` at startup
and refuses a network that `addresses.json` does not list, so nothing starts on 4663 until the launcher's step 6 has published
`chains["4663"]` (released SDK build). What differs on 4663, audited per service:

| Service | On 4663 | Evidence |
|---|---|---|
| web | Serves once published; **no faucet** (`faucetKind`), no "get test funds" hint, **no `/dev/*` pages** even with `NEXT_PUBLIC_DEV_PAGES=1`, `GEO_PLATFORM=static` refused, E2E mock wallet only on 31337 | `web/test/network.test.ts` |
| API | Serves once published (Phase 2 refusal removed) | `api/test/config.test.ts` |
| indexer | Once published; DEX volume from the real Uniswap v3 pools (same branch as `fork-4663`) | `indexer/test/network.test.ts` |
| compliance | Once published **and** a real sanctions provider + key (CP-R8) | `compliance/test/sanctions.test.ts` |
| keepers | Once published; chain 4663 for signing; guard pools, fee converter and liquidator swaps via the real UniversalRouter/pools; **liquidator needs `LIQUIDATOR_RECIPIENT`**; **feed mirror refuses 4663** (it writes mock feeds) | `keepers/test/common.test.ts` |

## 5. Launch

1. Announce 48h ahead (caps, geo restrictions, risks).
2. Owner lists markets at 25% of the target caps; allocator starts.
3. Watch the first weekend with the testnet weekend-watch checklist ([testnet.md](testnet.md) §3) and `GET /weekends`.
4. Raise caps in ×2 steps only after 2 weekends without a guard incident and a sim rerun (10 launch parameters).
