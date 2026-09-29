/**
 * USDG Earn (08, delta-neutral vault): the shapes the UI reads. Names follow what Phase 4 tasks 14–16 will expose
 * (`DeltaNeutralVault` reads, `/v1/vault/*`), so switching from fixtures to the real sources is mechanical.
 * Amounts are USDG (floats, 6 dp onchain); rates and weights are fractions (0.0934 = 9.34%).
 */
export type VaultWindow = "7d" | "30d" | "90d";
export type PauseReason = "cap_zero" | "cap_full" | "nav_stale" | "paused";

export interface VaultPoint {
  /** UTC seconds. */
  t: number;
  v: number;
}

export interface VaultSleeve {
  symbol: string;
  /** Target share of the vault. */
  weight: number;
  /** Per-sleeve cap, USDG (DN-R6). */
  cap: number;
  /** Net delta as a fraction of sleeve NAV (band ±bandPct, DN-R2). */
  delta: number;
  /** Perp margin ratio, × maintenance (DN-R3); null where the venue has no onchain margin view. */
  marginRatio: number | null;
  /** "unwound": moved to USDG by the funding kill switch (DN-R7). */
  status: "active" | "unwound";
}

export interface VaultOverview {
  asOf: {block: string; time: string};
  /** Net of costs and the performance fee. Historical, variable. `null` until the window has history (never a
   * projection, CP-R7). */
  apy: {d7: number | null; d30: number | null; d90: number | null};
  /** Daily net APY. */
  apySeries: VaultPoint[];
  /** USDG per share. */
  sharePriceSeries: VaultPoint[];
  /** Annualized contribution of each source over the window; costs are negative. */
  split: {window: VaultWindow; lending: number; funding: number; buffer: number; costs: number}[];
  sharePrice: number;
  tvl: number;
  cap: number;
  sleeves: VaultSleeve[];
  /** Fractions of NAV. */
  allocation: {lent: number; held: number; perpMargin: number; cash: number};
  /** USDG withdrawable now without queueing (the cash buffer). */
  instantCapacity: number;
  /** DN-R5: perp equity report age (null before the first report). */
  nav: {ageSec: number | null; stale: boolean};
  venue: {name: string; status: "ok" | "halted"};
  /** DN-R7: sleeves unwound to USDG. */
  killSwitch: {symbol: string; since: string}[];
  /** Null before the first trade. */
  lastRebalance: string | null;
  bandPct: number;
  /** × maintenance margin while markets are open, and while closed (08 weekend behaviour). */
  marginTarget: number;
  marginTargetClosed: number;
  /** Whether US markets are closed right now (weekend rules apply). */
  marketClosed: boolean;
  depositsOpen: boolean;
  pauseReason?: PauseReason;
  contracts: {vault: string; strategy: string; navOracle: string; perpAdapter: string};
}

export type RequestStatus = "queued" | "ready" | "claimed";

export interface WithdrawRequest {
  id: string;
  assets: number;
  shares: number;
  requestedAt: string;
  settlesAt: string;
  status: RequestStatus;
  /** Place in the FIFO queue (1 = next); 0 once ready or claimed. */
  position: number;
}

export interface VaultUser {
  shares: number;
  /** shares × share price, from the source (never computed from NAV in the UI). */
  value: number;
  /** Deposits minus withdrawals. 0 = not indexed yet, so earnings are unknown. */
  netDeposits: number;
  usdgBalance: number;
  usdgAllowance: number;
  requests: WithdrawRequest[];
}

export interface DepositPreview {
  shares: number;
  sharePrice: number;
}

/** DN-R1: instant up to the cash buffer, the rest queued until `settlesAt`. */
export interface WithdrawPreview {
  instant: number;
  queued: number;
  settlesAt?: string;
}

export interface Attestation {
  expiry: string;
  signature: `0x${string}`;
}

export interface TxResult {
  /** Undefined for the fixture ledger (nothing onchain to link to). */
  hash?: `0x${string}`;
}
