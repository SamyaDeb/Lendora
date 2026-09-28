# Runbook · Low keeper gas (`LOW_GAS`, MON-R15, P1; `LOW_GAS_CRITICAL`, P0)

**Trigger.** A watched keeper signer (`MONITOR_GAS_WATCH`) holds less ETH than 3 days (P1) or 1 day (P0) of burn. Burn =
max(`GAS_BURN_WEI_PER_DAY`, the burn measured over the last day, once ≥ 1h of samples exist). A top-up restarts the
measurement. The page details carry `balanceWei`, `burnWeiPerDay`, `measuredWeiPerDay` and `daysLeft`.

**Impact.** When the signer runs dry, every keeper that pays gas from it stops: the allocator (no pull on a guard trip),
the guard (no pokes, no DEVIATION trips), the liquidator (lenders exposed), and on testnet the feed mirror (feeds go
stale, `ORACLE_STALE`). On Phase 2 testnet one operator key pays for all of them.

## First 5 minutes

1. Read `daysLeft` and whether `measuredWeiPerDay` ≫ `GAS_BURN_WEI_PER_DAY`. A measured burn far above plan means a
   keeper is looping (resending, reverting): check `/health` and logs of each keeper before topping up.
2. `cast balance <signer> --rpc-url $RPC --ether` to confirm.
3. Top up (below). On testnet, if a top-up takes longer than the runway, stop the feed mirror first (it is the least
   critical sender; feeds going stale only trips the guard, which is safe).

## Decision tree

- Runaway sender → stop that keeper, fix, restart; then top up.
- Normal burn, runway short → top up to ≥ 14 days of burn.
- Testnet, no Sepolia ETH left → owner action: fund `0x3394…1348` on Sepolia (faucet) and bridge.

## Commands

```sh
# Testnet: bridge Sepolia ETH to Robinhood Chain testnet (lands in ~10–20 min). Chain check first.
[ "$(cast chain-id --rpc-url $SEPOLIA_RPC_URL)" = 11155111 ] && \
cast send 0xF2939afA86F6f933A3CE17fCAB007907B6b0B7a4 'depositEth()' --value 0.03ether \
  --rpc-url $SEPOLIA_RPC_URL --private-key $TESTNET_DEPLOYER_KEY
# Mainnet: transfer ETH to the keeper EOA from the team treasury.
```

**Who signs.** Testnet: the operator key. Mainnet: whoever holds the team treasury (a plain ETH transfer; no protocol role).
**Comms.** None unless a keeper actually stopped (then see [keeper-down.md](keeper-down.md)).
**Post-mortem.** Only for P0 (the P1 stage should have been enough warning); update `GAS_BURN_WEI_PER_DAY` if the plan
was wrong.
