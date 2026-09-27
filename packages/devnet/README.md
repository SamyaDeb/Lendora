# @stockline/devnet

Local chain for Stockline (Phase 2 task 0). Anvil only: every command checks the chain id is 31337.

| Piece | What |
|---|---|
| `fixtures/anvil-state.hex` | `anvil_dumpState` of `contracts/script/DeployLocal.s.sol` = `packages/sdk/addresses.json["31337"]` |
| `startAnvil()` / `connectAnvil()` | anvil on a free port with the fixture (or a fresh `DeployLocal`); impersonated sends, decoded reverts |
| `ChainDriver` | Moves the mocks like the real world (feed rounds, DEX rates and pool ticks together) and calls the real contracts: lend, withdraw, borrow, openShort, closeShort, repay, add/withdraw collateral, a standard Morpho liquidation, allocator passes, guardian trips, issuer pauses, multiplier changes, EIP-712 attestations from a generated key |
| `seedWeek()` | The seed week every Phase 2 test reuses: Wed–Tue with a Friday ramp-in, a frozen weekend, a Monday +15% NVDA gap and a liquidation, a guard trip with a rejected borrow, a SPY dividend multiplier change |
| `startPostgres()` / `startRedis()` | `DATABASE_URL` / `REDIS_URL` if set, else throwaway local instances |

```sh
pnpm --filter @stockline/devnet drive serve            # anvil + fixture on :8545
pnpm --filter @stockline/devnet drive seed             # seed week against $RPC_URL (default :8545)
pnpm --filter @stockline/devnet drive live             # fresh rounds + allocator every 15 s while the feed is open
pnpm --filter @stockline/devnet state:dump             # regenerate the fixture from a running node
```

The whole stack: `scripts/dev.sh` (see its header) or `docker compose up -d` for Postgres, Redis and anvil.
