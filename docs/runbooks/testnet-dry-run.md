# Testnet dry run (anvil fork of 46630)

Run on 2026-09-27T15:55:56.097Z by `web/scripts/testnetDryRun.ts` (30 s). Nothing was sent to the
testnet: the deployment and every transaction ran on a local anvil fork. The real deployment waits for the owner's go.

| Step | Result |
|---|---|
| Fork | anvil fork of 46630 at block 125245367; DeployTestnet (--slow, ~320 txs) on the fork: 124 s |
| Feed mirror | pushed 4 mainnet rounds (AAPL 34145318048, NVDA 22566018707, SPY 77232802713, USDG 99994000) to the mock feeds and DEX |
| Smoke flows | 13 actions: lend, allocate, openShort, addCollateral, repay, closeShort, borrow, withdrawCollateral, withdrawLend (openShort/borrow attested by the compliance service) |
| Indexer | backfill from block 125245367 to 125245757: 25 s (22266 ms to ready) |
| 07 acceptance | /v1/markets/{symbol} = ShortInterestLens.snapshot() at the same block for 3/3 stocks |
| SI-R5 reconciliation | 48 values at block 125245757: 0 diffs |
| /v1/status | lag 0 blocks; AAPL closed, NVDA closed, SPY closed |
