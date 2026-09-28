# Runbook drills on an anvil fork of 46630 (Phase 3 task 11)

Run 2026-09-28T18:38:41.709Z by `packages/devnet/test/forkDrills.test.ts` (292 s). **Rehearsed on a fork, not on testnet**: no
"go testnet" was given, so every transaction below ran on a local anvil fork of 46630 at block 125834808 (the real
testnet deployment and its 24h timelocks). The testnet deployer (holder of every testnet role, A27) was impersonated.
Tx hashes are fork-local. Ran by: engineering (Claude Code session), owner review pending.

| # | Drill | Runbook | Result | Chain time (UTC) | Fork txs |
|---|---|---|---|---|---|
| 1 | Deploy FeeSplitter + 2 FeeConverters (`DeployTestnetFees.s.sol`, TESTNET_GO=fork-dry-run) | list-stock.md (fees) | splitter 0x1BC7b6DaAd4AdB42AC3eCFF504db01d95Da77b49, converters 0x5320501F285Bc16674c0875edFf32B85d9727964 / 0x911D584E8C37fa764B3cB0EC462939b0365B16dc, all owned by the timelock | 2026-09-28T18:35 | – |
| 2 | Turn the 10% performance fee on (recipient, then fee) in all 3 vaults through the 24h curator timelock | list-stock.md (fees) | refused before 24h, executed after; recipient = FeeSplitter, fee = 10% | 2026-10-04T18:36 | `0xd6f5efac…` `0xb8413be2…` `0xe810426e…` `0x4676e96a…` `0xb6da9409…` `0xd257aefb…` `0x0608be49…` `0x782b998e…` `0xb3c8ec76…` `0x69092be0…` `0xfc460676…` `0x3fd761f7…` |
| 3 | First distribution (NVDA, after 2 days of interest) | keeper-down.md (MON-R20) | 150983353988416 fee shares → 75491676994208 treasury / 75491676994208 backstop converter | 2026-10-06T18:36 | `0xfa96a0d9…` `0x4167b483…` |
| 4 | First conversion (treasury share, NVDA → USDG through the mock DEX) | list-stock.md (fees), FE-R4 | oracle value 17035 USDG raw, floor 16865, received 17035; non-keeper and below-floor calls refused | 2026-10-06T18:36 | `0x507a76ae…` |
| 5 | Guard tripped (MANUAL) and cleared by the guardian | guard-tripped.md | pull emptied free liquidity; borrow refused (GuardTripped); repay worked; guard cleared | 2026-10-06T18:36 | `0x8a2af5bb…` `0x1d077c3c…` |
| 6 | Allocator down during a trip: guardian deallocates by hand | keeper-down.md, guard-tripped.md | sentinel deallocated 430999137448863250889 (allocation 450002101503494145011 → 19002964056870324738); detection of the down keeper is the monitor test (MON-R9) | 2026-10-06T18:36 | `0x263a7ead…` `0x1ce8bbbe…` |
| 7 | Multiplier change (SPY +30%, no pause window) → MULTIPLIER latched → owner confirms | multiplier-change.md | latched; cleared through the timelock after 86400 s | 2026-10-07T18:36 | `0x02c66f2e…` `0x6cfd80cd…` `0xc5ffb27d…` |
| 8 | Oracle re-anchor after a 2.1x move | oracle-stale-or-rejected.md | SANITY latched; resetReferences through the timelock (86400 s); accepted afterwards | 2026-10-08T18:37 | `0xad20b1a7…` `0x167f3de5…` |
| 9 | Calendar push (AAPL earnings window) | calendar-push.md | event 1 onchain after the timelock | 2026-10-09T18:37 | `0x5de3e7b6…` `0x9657096f…` |
| 10 | Unexpected schedule (attestation signer → attacker) decoded and cancelled | governance-change.md | page text: "router.setAttestationSigner(0x00000000000000000000000000000000000bAD01)"; cancelled; execute refused after the delay | 2026-10-10T18:37 | `0x3104c899…` `0x25ef7b81…` |
| 11 | P0 tabletop: wrapper backing shortfall (issuer adminBurn 1 NVDA) | wrapper-backing-shortfall.md | shortfall 1000000000000000000; delisted through the timelock; borrow refused (NotListed); repay + withdraw all worked | 2026-10-11T18:37 | `0x1d8e1644…` `0x7eceb43b…` `0x4d933fcf…` `0xad6084ea…` |

Re-run: `FORK_DRILLS_46630=1 FORK_DRILLS_REPORT=1 pnpm --filter @stockline/devnet exec vitest run test/forkDrills.test.ts`.
