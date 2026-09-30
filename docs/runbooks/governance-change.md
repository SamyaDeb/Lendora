# Runbook · Governance change (`TIMELOCK_SCHEDULED` MON-R16 P1, `TIMELOCK_EXECUTED` MON-R17 P1 / `_UNTRACKED` P0, `ROLE_CHANGED` MON-R18 P0)

**Trigger.**
- `TIMELOCK_SCHEDULED`: a `CallScheduled` on the Lendora `TimelockController`, a `Cancelled`, or a Vault V2 curator
  `Submit` / `Revoke` (each vault's own timelock). The page title is the call decoded by the SDK
  (`decodeLendoraCall`), e.g. `router.setSwapTarget(0x…, 2)` or `vault:NVDA.setPerformanceFeeRecipient(0x…)`.
  Auto-resolves after 72h.
- `TIMELOCK_EXECUTED`: the matching `CallExecuted` / vault `Accept`. **P0 `TIMELOCK_EXECUTED_UNTRACKED`** when the
  monitor never saw (and paged) the schedule: nobody had the 48h to react. Auto-resolves after 24h.
- `ROLE_CHANGED`: ownership (`OwnershipTransferred`, vault `SetOwner`), curator, sentinel, allocator, oracle
  guardian/keeper (`RoleSet`), attestation signer, router implementation (`Upgraded`), converter keeper/destination,
  fee recipients (`RecipientsSet`), timelock roles or min delay. Auto-resolves after 24h.

The monitor's governance cursor starts at the head on its first run: **start the monitor before the first governance
action** (mainnet-launch §4), or every later execution of an earlier schedule pages as untracked.

**Impact.** The owner multisig (4-of-7) is the only proposer; the 48h delay exists so users and the guardian can
react to a malicious or mistaken change (threat model §7). An unexpected schedule means a multisig compromise, a
mistake, or an undocumented change.

## First 5 minutes

1. Is it in the change log? Every planned owner action has a ticket with its `scheduleCalldata` and salt
   (`pnpm --filter @lendora/sdk timelock …`). Compare the page's decoded call and `id` with the ticket.
2. Expected → acknowledge; note the execution time (`executableAt` / scheduled + delay) in the ticket.
3. **Not expected** → treat as P0: page the owner signers and the guardian, and freeze the change (below).
4. `ROLE_CHANGED` without a matching executed timelock operation in the last 48h → P0: something bypassed the path
   (a vault owner or curator key, or an unknown admin).
5. `TIMELOCK_EXECUTED_UNTRACKED` → find why the schedule was not paged (monitor down? started late?) and review the
   executed call like an unexpected one.

## Decision tree

- Unexpected `CallScheduled` → owner Safe cancels it (`cancel(id)`, needs the canceller role = owner Safe) before
  `executableAt`; guardian trips the affected markets (`trip(MANUAL)`) and pulls liquidity meanwhile; comms: "a
  governance change was proposed without notice; exits keep working; new borrowing paused".
- Unexpected vault `Submit` → curator or guardian (sentinel) calls `revoke(data)` on the vault before `executableAt`.
- Unexpected execution already happened → assess the new state (swap target, fee recipient, signer, implementation);
  guardian trip + pull; exits keep working (CP-R4); plan the reverse change through the timelock; post-mortem.
- Key compromise suspected → rotate the Safe signers (Safe settings), re-check every role with
  `script/VerifyRoles.s.sol`.

## Commands

```sh
cast call $TIMELOCK "isOperationPending(bytes32)(bool)" <id> --rpc-url $RPC
cast calldata "cancel(bytes32)" <id>                                          # owner Safe, to = $TIMELOCK
cast calldata "revoke(bytes)" <data>                                          # curator or guardian Safe, to = $VAULT
cast call $VAULT "executableAt(bytes)(uint256)" <data> --rpc-url $RPC
cast calldata "trip(uint256)" 1                                               # guardian Safe, to = $ORACLE
forge script script/VerifyRoles.s.sol --rpc-url $RPC                          # every role check, pass/fail table
```

Rehearsed on anvil: `keepers/test/monitor.test.ts` (schedule, execution tracked and untracked, `SetIsSentinel` through
the real `TimelockController`).
