# Runbook drills on an anvil fork of 46630 (Phase 3 task 11, Phase 4 Part C)

Run 2026-09-29T09:36:49.303Z by `packages/devnet/test/forkDrills.test.ts` (501 s). **Rehearsed on a fork, not on testnet**: no
"go testnet" was given, so every transaction below ran on a local anvil fork of 46630 at block 126131160 (the real
testnet deployment and its 24h timelocks). The testnet deployer (holder of every testnet role, A27) was impersonated.
Tx hashes are fork-local. Ran by: engineering (Claude Code session), owner review pending.

| # | Drill | Runbook | Result | Chain time (UTC) | Fork txs |
|---|---|---|---|---|---|
| 1 | Deploy FeeSplitter + 2 FeeConverters (`DeployTestnetFees.s.sol`, TESTNET_GO=fork-dry-run) | list-stock.md (fees) | splitter 0x1BC7b6DaAd4AdB42AC3eCFF504db01d95Da77b49, converters 0x5320501F285Bc16674c0875edFf32B85d9727964 / 0x911D584E8C37fa764B3cB0EC462939b0365B16dc, all owned by the timelock | 2026-09-29T09:31 | – |
| 2 | Turn the 10% performance fee on (recipient, then fee) in all 3 vaults through the 24h curator timelock | list-stock.md (fees) | refused before 24h, executed after; recipient = FeeSplitter, fee = 10% | 2026-10-05T09:32 | `0xd6f5efac…` `0xb8413be2…` `0xe810426e…` `0x4676e96a…` `0xb6da9409…` `0xd257aefb…` `0x0608be49…` `0x782b998e…` `0xb3c8ec76…` `0x69092be0…` `0xfc460676…` `0x3fd761f7…` |
| 3 | First distribution (NVDA, after 2 days of interest) | keeper-down.md (MON-R20) | 138741135280295 fee shares → 69370567640147 treasury / 69370567640148 backstop converter | 2026-10-07T09:32 | `0xfa96a0d9…` `0x4167b483…` |
| 4 | First conversion (treasury share, NVDA → USDG through the mock DEX) | list-stock.md (fees), FE-R4 | oracle value 15654 USDG raw, floor 15498, received 15654; non-keeper and below-floor calls refused | 2026-10-07T09:33 | `0xbdd91fa7…` |
| 5 | Deploy the DN vault, strategy, NAV oracle and gated mock venue (`DeployTestnetVault.s.sol`, TESTNET_GO=fork-dry-run) | dn-*.md | vault 0xcaBF25f235bc7c39D3C6Fd25f4C60B822EA7eED1; owner = timelock; total and sleeve caps 0 (Q11); fee → FeeSplitter; 3 sleeves | 2026-10-07T09:33 | – |
| 6 | NAV signers (2), compliance signer rotation and a fork-only 100k cap in one 24h timelock window | dn-nav-stale.md, key rotation | 8 operations scheduled together, refused before 86400 s, executed after | 2026-10-08T09:33 | `0x6ddd4241…` `0x6a56691c…` `0xeb920398…` `0x7a691cab…` `0x3bb7537f…` `0xf38f33da…` `0xa8948e0e…` `0xbead8544…` `0x7d3e2648…` `0xe1f3ed11…` `0x309bc1fe…` `0x2055cae1…` `0x7f9f9e19…` `0x5bd8de3a…` `0x59c6b7b1…` `0xeccbcd27…` |
| 7 | USDG Earn flows on the fork: deposit (attested) → build NVDA sleeve → instant withdrawal → queued request → settle → claim | dn-queue-overdue.md | deposit 60k; instant 5k; request 30k shares settled at 29999999999 USDG raw and claimed; NAV reports signed by both NAV signers | 2026-10-08T09:35 | `0x070808f9…` `0xded19e6e…` `0xae33544d…` `0xaed2adbb…` |
| 8 | Guard tripped (MANUAL) and cleared by the guardian | guard-tripped.md | pull emptied free liquidity; borrow refused (GuardTripped); repay worked; guard cleared | 2026-10-08T09:35 | `0x47b0d8c3…` `0xe41a880b…` |
| 9 | Allocator down during a trip: guardian deallocates by hand | keeper-down.md, guard-tripped.md | sentinel deallocated 430999146897944447923 (allocation 450002071552644537083 → 19002924656513208555); detection of the down keeper is the monitor test (MON-R9) | 2026-10-08T09:35 | `0x25264d09…` `0x3a78b0b5…` |
| 10 | Multiplier change (SPY +30%, no pause window) → MULTIPLIER latched → owner confirms | multiplier-change.md | latched; cleared through the timelock after 86400 s | 2026-10-09T09:36 | `0xcc9c18b8…` `0x874464d8…` `0x91fb5414…` |
| 11 | Oracle re-anchor after a 2.1x move | oracle-stale-or-rejected.md | SANITY latched; resetReferences through the timelock (86400 s); accepted afterwards | 2026-10-10T09:36 | `0x3904e5f4…` `0x09415528…` |
| 12 | Calendar push (AAPL earnings window) | calendar-push.md | event 1 onchain after the timelock | 2026-10-11T09:36 | `0x17c52e01…` `0xdabd2b84…` |
| 13 | Unexpected schedule (attestation signer → attacker) decoded and cancelled | governance-change.md | page text: "router.setAttestationSigner(0x00000000000000000000000000000000000bAD01)"; cancelled; execute refused after the delay | 2026-10-12T09:36 | `0x4dfffc89…` `0xdeeaa026…` |
| 14 | P0 tabletop: wrapper backing shortfall (issuer adminBurn 1 NVDA) | wrapper-backing-shortfall.md | shortfall 1000000000000000000; delisted through the timelock; borrow refused (NotListed); repay + withdraw all worked | 2026-10-13T09:36 | `0x98e5bd30…` `0x93350535…` `0xc02cb3e3…` `0x8add4b38…` |

Re-run: `FORK_DRILLS_46630=1 FORK_DRILLS_REPORT=1 pnpm --filter @stockline/devnet exec vitest run test/forkDrills.test.ts`.
