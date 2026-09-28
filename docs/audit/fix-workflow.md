# Audit finding → fix workflow

For findings from the audits (round 1, round 2 / delta, Phase 4), the bug bounty and internal reviews. The goal: every
finding has an ID, a decision, a failing-first test, one reviewable commit, and a re-review of the diff against the
freeze. Status lives in [findings.md](findings.md).

## 1. Intake

1. Give the finding an ID: `<source>-<nn>` — `R1-07` (round 1), `R2-03` (round 2), `P4-01` (Phase 4 audit),
   `BB-2027-004` (bug bounty), `OFF-18` (offchain review). Keep the auditor's own ID in the table too.
2. Add a row to [findings.md](findings.md): severity (auditor's, and ours if different), affected files, requirement IDs
   (e.g. `RT-R3`, `FE-R4`), owner, status `open`.
3. Decide within 3 working days: **fix**, **accept** (known issue: add it to README §7/§8.5 with the reason and the
   owner's written acceptance), or **dispute** (reply with a test or proof; the auditor closes it).
4. Critical/High on deployed code: follow the P0/P1 runbook first ([runbooks](../runbooks/README.md)), then this workflow.

## 2. Branch and failing-first test

```sh
git switch -c fix/R2-03-converter-floor-rounding
```

- Write the test that reproduces the finding **before** the fix and commit it (or show it failing in the PR):
  `test_R2_03_<what>` in the relevant `contracts/test/**` suite (or the TS package's test file), plus the requirement
  ID if one applies (`test_R2_03_FE_R4_floorRoundsUp`).
- For invariant findings, add or extend an `invariant_*` and run it at `FOUNDRY_PROFILE=deep`.
- Run it and keep the failing output (the PR description quotes it).

## 3. Fix

- Smallest change that makes the test pass. Frozen files ([README §1](README.md#1-scope)) change only here, and each such
  change is recorded in README §8.3 "Post-freeze diff": `file · commit · why · test`.
- Router size: `forge build --sizes` in the same commit (484 bytes of EIP-170 headroom at the round-1 freeze).
- Full quality bar: `forge fmt --check`, `forge test`, slither (no medium+, new lows triaged in `slither.config.json`
  with a reason), coverage ≥ 95% per `src/` file, `forge doc`, `pnpm -r typecheck && pnpm -r lint && pnpm -r test`.
- ABI change → `node packages/sdk/scripts/export-abis.mjs`, regenerate `api/openapi.json` /
  `packages/sdk/src/api/schema.ts` if touched, update callers, re-run the web revert-decoder coverage test (OFF-14).

## 4. Commit message

```
fix(<scope>): <what changed in plain words> (R2-03, FE-R4)

Finding: <auditor's title> (<auditor id>), <severity>.
Cause: <one or two lines>.
Fix: <one or two lines>.
Test: test_R2_03_FE_R4_floorRoundsUp (failed before: <assertion>).
Post-freeze diff: contracts/src/fees/FeeConverter.sol (+3/-1).

Co-Authored-By: …
```

One finding per commit; no unrelated changes. Squash fixups before re-review.

## 5. Re-review

1. Produce the diff the auditor reviews: `git diff $(cat docs/audit/FREEZE) <fix-commit> -- contracts/src contracts/script`
   (round 2: against the round-2 freeze commit).
2. Send the commit hash, the test, and the diff; the auditor marks the finding `fixed` / `partially fixed` / `not fixed`.
3. Update [findings.md](findings.md) (status, fix commit, re-review result, date) and README §8.3.
4. Deployed code: the fix ships through the 48h timelock (router upgrade, oracle/param change) with the monitor paging the
   schedule (MON-R16); `VerifyRoles` re-run after execution; the launch log records both.

## 6. Status values

`open` → `fix in progress` → `fixed (pending re-review)` → `closed` · or `accepted (known issue n)` · or
`disputed` → `closed (not an issue)`.
