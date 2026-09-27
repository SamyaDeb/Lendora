# Runbook · Guarded mainnet launch (Phase 3)

The deployment and role checklist for chain 4663. **Nothing here runs without the owner's go**; every box needs a
named person and evidence (tx hash, screenshot, link) in the launch log. Deploy logic: `contracts/script/StocklineDeploy.sol`
(the `_deployCore` / `_deployStock` / `_finalize` steps the fork suite exercises); per-stock steps:
[list-stock.md](list-stock.md).

## 0. Gates (all must be ✅ before the deploy transaction)

- [ ] Two audits closed; every finding fixed or accepted in writing; fixes re-reviewed against the freeze
      ([`docs/audit`](../audit/README.md)).
- [ ] Counsel opinions (06 legal questions A–D) and terms of use / risk disclosure signed off (CP-R6).
- [ ] Sanctions provider contracted and live: `SANCTIONS_PROVIDER=chainalysis|trm`, `SANCTIONS_API_KEY` in the secret
      store (Q5). The compliance service refuses to start on 4663 with the deny-list (CP-R8).
- [ ] Risk owner signed off the sim report (σ, z, event buffers, caps; 04 acceptance) and the weekday DEX depth run.
- [ ] 2 clean testnet weekends (`GET /weekends` evidence) and 20 external testers (Phase 2 exit).
- [ ] Runbooks drilled on testnet: at least guard-tripped, oracle re-anchor, calendar-push, multiplier-change,
      keeper-down, and one P0 tabletop (bad-debt or wrapper shortfall); dates in [README.md](README.md).
- [ ] Bug bounty live (e.g. Immunefi), max payout sized to the caps.

## 1. Multisigs and keys (hardware wallets only)

| Role | Setup | Check |
|---|---|---|
| Owner | Safe **4-of-7**, signers on hardware wallets, ≥ 3 organizations or independent people | `getThreshold() == 4`, `getOwners().length == 7` |
| Guardian (= Vault V2 sentinel) | Safe **2-of-4**, on-call rotation covers 24/7 | `getThreshold() == 2`, `getOwners().length == 4` |
| Allocator | Keeper EOA from KMS/HSM (remote signer) **and** the owner Safe as a second allocator | `isAllocator` true for both |
| Guard keeper | Separate KMS key | `oracle.keeper()` per market |
| Liquidator bot | Separate KMS key, funded with USDG working capital | – |
| Compliance signer | KMS key, never exported (`COMPLIANCE_REMOTE_SIGNER_URL`) | `router.attestationSigner()` |
| Deployer | Fresh EOA, used once, then emptied; holds **no** role after `_finalize` | every role check below shows no deployer |

**A27 must not carry over:** on testnet one key held every role; on mainnet **every** `STOCKLINE_*` role is a
distinct address from the table above. Verify with `test/deploy/DeployRoles.t.sol` logic on a fork of the final config
before broadcasting.

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

## 3. Deploy

1. Final dry run on a fork of the latest block with the exact config:
   `forge script script/DeployFork.s.sol --fork-url $ROBINHOOD_RPC_URL --sender <deployer>`; run the phase 1 fork
   suite against it; compare `addresses.json["fork-4663"]`.
2. Broadcast with the fresh deployer (owner's go recorded in the launch log). Verify every contract on the explorer
   (Sourcify + Blockscout).
3. Commit `packages/sdk/addresses.json["4663"]`; re-export ABIs if anything changed; tag the release.
4. Role checks (all must hold; record the `cast call` outputs):
   router `owner() == timelock`; each oracle `owner() == timelock`, `guardian() == guardian Safe`,
   `keeper() == guard keeper`; `MarketHours.owner() == timelock`; each vault `owner() == timelock`,
   `curator() == owner Safe`, `isSentinel(guardian Safe)`, allocators as in §1; liquidator `owner() == owner Safe`;
   deployer holds nothing.
5. Vault V2 code hash equals the official factory's (`VaultV2CodeHash.fork.t.sol` logic against the new vaults).

## 4. Services before the first deposit

- [ ] Compliance: `PROXY_SECRET` (≥ 32 chars) shared with web, `GEO_PLATFORM` set, `TRUST_PROXY=true`, sanctions
      provider live, `ALLOWED_ORIGINS` = the app's origin; smoke: a direct request with `cf-ipcountry` and no secret →
      `403 GEO_UNKNOWN`.
- [ ] Monitoring on: `SERVICE=monitor` with PagerDuty or Opsgenie, `MONITOR_KEEPERS` listing every keeper, on-call
      schedule set; test page acknowledged end to end.
- [ ] Keepers live (`DRY_RUN=false`, remote signers): allocator, guard, liquidator; alerts service; indexer, API,
      daily reconcile.
- [ ] Calendar runway ≥ 30 days pushed; earnings windows within 60 days pushed (MON-R13 quiet).
- [ ] Status page and comms channels ready; comms templates from [README.md](README.md).

## 5. Launch

1. Announce 48h ahead (caps, geo restrictions, risks).
2. Owner lists markets at 25% of the target caps; allocator starts.
3. Watch the first weekend with the testnet weekend-watch checklist ([testnet.md](testnet.md) §3) and `GET /weekends`.
4. Raise caps in ×2 steps only after 2 weekends without a guard incident and a sim rerun (10 launch parameters).
