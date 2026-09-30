import type {Severity} from "./pager.js";

/**
 * The operator alert rules of docs/prd/10 "Monitoring and paging", one requirement ID each (MON-R1…R26). State rules
 * fire while their condition holds (after `forBlocks` / `forSec` if set) and resolve when it stops; event rules
 * (a log was seen) fire once per subject and resolve after `autoResolveSec` (the page stays in the provider's history;
 * the runbook drives the follow-up).
 */
export type RuleId =
  | "BAD_DEBT"
  | "MISSED_LIQUIDATION"
  | "BACKING_SHORTFALL"
  | "CLUSDG_BACKING"
  | "ORACLE_STALE"
  | "FEED_REJECTED"
  | "GUARD_TRIPPED"
  | "L2_GAP"
  | "KEEPER_DOWN"
  | "DIRECT_BORROW"
  | "PULL_NOT_EFFECTIVE"
  | "UTILIZATION_HIGH"
  | "CALENDAR_RUNWAY"
  | "INDEXER_LAG"
  | "LOW_GAS"
  | "LOW_GAS_CRITICAL"
  | "TIMELOCK_SCHEDULED"
  | "TIMELOCK_EXECUTED"
  | "TIMELOCK_EXECUTED_UNTRACKED"
  | "ROLE_CHANGED"
  | "LIQUIDATION_UNPROFITABLE"
  | "FEE_NOT_DISTRIBUTED"
  | "DN_DELTA_BREACH"
  | "DN_MARGIN_LOW"
  | "DN_NAV_STALE"
  | "DN_QUEUE_OVERDUE"
  | "DN_KILL_SWITCH"
  | "COLLATERAL_BELOW_BUFFER";

export interface RuleMeta {
  req: string;
  severity: Severity;
  /** docs/runbooks page (task 4). */
  runbook?: string;
  /** Condition must hold for at least this many blocks since first seen. */
  forBlocks?: bigint;
  /** …and at least this many seconds of chain time. */
  forSec?: bigint;
  /** Event rules: resolve this long after the incident opened. */
  autoResolveSec?: number;
}

const rb = (f: string) => `docs/runbooks/${f}`;

export const RULES: Record<RuleId, RuleMeta> = {
  BAD_DEBT: {req: "MON-R1", severity: "P0", runbook: rb("bad-debt.md"), autoResolveSec: 24 * 3600},
  // "HF < 1.0 for > 2 blocks": first seen at block b, fires at b + 3.
  MISSED_LIQUIDATION: {req: "MON-R2", severity: "P0", runbook: rb("missed-liquidation.md"), forBlocks: 3n},
  BACKING_SHORTFALL: {req: "MON-R3", severity: "P0", runbook: rb("wrapper-backing-shortfall.md")},
  CLUSDG_BACKING: {req: "MON-R4", severity: "P0", runbook: rb("usdg-freeze.md")},
  ORACLE_STALE: {req: "MON-R5", severity: "P1", runbook: rb("oracle-stale-or-rejected.md")},
  FEED_REJECTED: {req: "MON-R6", severity: "P1", runbook: rb("oracle-stale-or-rejected.md")},
  GUARD_TRIPPED: {req: "MON-R7", severity: "P1", runbook: rb("guard-tripped.md")},
  L2_GAP: {req: "MON-R8", severity: "P1", runbook: rb("sequencer-l2-gap.md")},
  KEEPER_DOWN: {req: "MON-R9", severity: "P1", runbook: rb("keeper-down.md")},
  DIRECT_BORROW: {req: "MON-R10", severity: "P1", runbook: rb("direct-borrow.md"), autoResolveSec: 3600},
  // "Guard tripped and free liquidity > 0 after 2 blocks".
  PULL_NOT_EFFECTIVE: {req: "MON-R11", severity: "P1", runbook: rb("guard-tripped.md"), forBlocks: 2n},
  UTILIZATION_HIGH: {req: "MON-R12", severity: "P2", forSec: 3600n},
  CALENDAR_RUNWAY: {req: "MON-R13", severity: "P2", runbook: rb("calendar-push.md")},
  INDEXER_LAG: {req: "MON-R14", severity: "P2", runbook: rb("keeper-down.md")},
  // Keeper signer ETH below N days of burn (Phase 2 testnet: one operator key pays every keeper).
  LOW_GAS: {req: "MON-R15", severity: "P1", runbook: rb("low-gas.md")},
  LOW_GAS_CRITICAL: {req: "MON-R15", severity: "P0", runbook: rb("low-gas.md")},
  // Phase 3 (mainnet): governance and economics. Event rules resolve by time; the provider keeps the history.
  TIMELOCK_SCHEDULED: {req: "MON-R16", severity: "P1", runbook: rb("governance-change.md"), autoResolveSec: 72 * 3600},
  TIMELOCK_EXECUTED: {req: "MON-R17", severity: "P1", runbook: rb("governance-change.md"), autoResolveSec: 24 * 3600},
  // Executed without the monitor having paged its schedule: nobody had the delay to react.
  TIMELOCK_EXECUTED_UNTRACKED: {req: "MON-R17", severity: "P0", runbook: rb("governance-change.md"), autoResolveSec: 24 * 3600},
  ROLE_CHANGED: {req: "MON-R18", severity: "P0", runbook: rb("governance-change.md"), autoResolveSec: 24 * 3600},
  LIQUIDATION_UNPROFITABLE: {req: "MON-R19", severity: "P1", runbook: rb("missed-liquidation.md")},
  FEE_NOT_DISTRIBUTED: {req: "MON-R20", severity: "P2", runbook: rb("keeper-down.md"), forSec: 8n * 86_400n},
  // Phase 4 delta-neutral vault (08). The rebalancer fixes a breach within a tick or two: page if it persists.
  DN_DELTA_BREACH: {req: "MON-R21", severity: "P1", runbook: rb("dn-delta-breach.md"), forSec: 1800n},
  DN_MARGIN_LOW: {req: "MON-R22", severity: "P0", runbook: rb("dn-margin-low.md")},
  DN_NAV_STALE: {req: "MON-R23", severity: "P1", runbook: rb("dn-nav-stale.md"), forSec: 300n},
  DN_QUEUE_OVERDUE: {req: "MON-R24", severity: "P0", runbook: rb("dn-queue-overdue.md")},
  DN_KILL_SWITCH: {req: "MON-R25", severity: "P1", runbook: rb("dn-kill-switch.md")},
  // T10 / residual (e): a collateral withdrawal (router or Morpho-direct) left a position with debt below the 24h
  // buffer (HF at t + 24h < 1.10). State rule: resolves when the position is back above it or the debt is gone.
  COLLATERAL_BELOW_BUFFER: {req: "MON-R26", severity: "P2", runbook: rb("collateral-below-buffer.md")},
};

/** Oracle guard reason bits (LendoraOracleBase), by name. */
export const REASONS: Record<string, bigint> = {
  MANUAL: 1n,
  DEVIATION: 2n,
  L2_GAP: 4n,
  STALE: 8n,
  SANITY: 16n,
  USDG_FEED: 32n,
  ORACLE_PAUSED: 64n,
  TOKEN_PAUSED: 128n,
  WRAPPER_BLOCKED: 256n,
  MULTIPLIER: 512n,
  SEQUENCER: 1024n,
  CALENDAR: 2048n,
};

export const FEED_REJECT_BITS = REASONS.SANITY | REASONS.USDG_FEED;

export function reasonNames(bits: bigint): string[] {
  return Object.entries(REASONS)
    .filter(([, b]) => (bits & b) !== 0n)
    .map(([n]) => n);
}

/** One observation of a rule for one subject in a tick. `active: false` resolves an open incident. */
export interface Observation {
  rule: RuleId;
  subject: string;
  active: boolean;
  title: string;
  details: Record<string, unknown>;
}
