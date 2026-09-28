# Runbook · Keeper down (`KEEPER_DOWN`, MON-R9, P1) and indexer lag (`INDEXER_LAG`, MON-R14, P2)

**Trigger.** A keeper's `/health` is not 200 (allocator, guard, liquidator, alerts, fee-converter; the allocator's turns 503 after
5 min without a run, LM-R33). `INDEXER_LAG`: the indexer is > 20 blocks behind, or the SI-R5 reconciliation found a
difference between indexed and onchain values.

**Impact.**
| Keeper | While it is down |
|---|---|
| allocator | New deposits are not lent out; **a guard trip does not pull liquidity** (watch `PULL_NOT_EFFECTIVE`) |
| guard | No DEVIATION / L2_GAP trips; nobody pokes (onchain reasons are still evaluated live by the router) |
| liquidator | Only third-party liquidators protect lenders (watch `MISSED_LIQUIDATION`) |
| alerts | Users get no HF / ramp alerts |
| fee-converter | Fee shares wait in the `FeeSplitter` / `FeeConverter`s (no user impact; `FEE_NOT_DISTRIBUTED` pages after 8 days above $1k). Anyone can call `FeeSplitter.distribute`; only the fee keeper can convert (FE-R4) |
| indexer | API, dashboard and the monitor's position list go stale (safety views read the chain) |

## First 5 minutes

1. `curl <keeper>/health | jq` (per-market `lastRunMsAgo`, `error`); platform logs (Railway) for crash loops.
2. RPC reachable? `cast block-number --rpc-url $RPC` from the same network.
3. Keeper key funded? `cast balance <keeper address>` (allocator and guard pay gas).
4. Restart the service; confirm `/health` 200 and the monitor resolves.
5. If the allocator stays down during a guard trip: the guardian (sentinel) deallocates by hand
   ([guard-tripped.md](guard-tripped.md)).

## Decision tree

- Crash loop on a code error → roll back to the previous image; open an incident on the bug.
- RPC provider outage → switch `RPC_URL` to the backup provider for all keepers.
- Indexer lag → restart; Ponder resumes from its checkpoint on the same schema. Reconciliation diff → read the diff
  (`INDEXER_LAG:reconcile` details): known cause A29 (a donation to a vault moves idle without an event) is display-only;
  anything else → resync the indexer into a new schema and switch the API's `INDEXER_SCHEMA`.

## Commands

```sh
curl -s $ALLOCATOR_URL/health | jq; curl -s $GUARD_URL/health | jq; curl -s $LIQUIDATOR_URL/health | jq
railway redeploy --service allocator            # or the platform's restart
DRY_RUN=false KEEPER_SIGNER=env-key pnpm --filter @stockline/keepers allocator   # run locally as a stopgap (needs the key)
pnpm --filter @stockline/indexer reconcile      # SI-R5 on demand
```

**Who signs.** On-call engineer (restart); guardian 2-of-4 for manual pulls.

## Comms

None unless users are affected (alerts down > 1h: status page note).

## Post-mortem

- [ ] Root cause and time to detect / restart; add a redundant instance if > 1 incident per month
