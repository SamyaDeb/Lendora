import {WAD} from "./wad.js";

/**
 * Allocator decision rule for one Vault V2 + MorphoMarketV1AdapterV2 market (docs/prd/03-lending-markets.md §4,
 * LM-R30…R34 restated for Vault V2, D6). Pure: the keeper reads state, calls `planAllocation`, sends at most one tx.
 * All amounts in raw wSTOCK units.
 */
export interface AllocatorState {
  /** `vault.totalAssets()` (accrued view). */
  totalAssets: bigint;
  /** Unallocated wSTOCK held by the vault. */
  idle: bigint;
  /** `vault.allocation(marketCapId)` (last recorded). */
  allocation: bigint;
  /** Smallest absolute cap across the adapter's three ids. */
  absoluteCap: bigint;
  /** Smallest relative cap across the three ids (WAD; 1e18 = none). */
  relativeCap: bigint;
  /** `adapter.expectedSupplyAssets(marketId)`: what the vault owns in the market. */
  adapterAssets: bigint;
  /** Morpho market totals (accrued). */
  marketSupply: bigint;
  marketBorrow: bigint;
  /** Oracle guard tripped (OR-R30) or inside a pre-event pull window (D5). */
  pull: boolean;
}

export interface AllocatorParams {
  /** Utilization cap, WAD (0.9e18 at launch). */
  uMax: bigint;
  /** Ignore moves smaller than this (raw units) to avoid churn. */
  minMove: bigint;
}

export type AllocatorAction = {kind: "none"; reason: string} | {kind: "allocate" | "deallocate"; assets: bigint; reason: string};

/** Liquidity `deallocate` can take now (LM-R34): what the vault owns, capped by the market's unborrowed liquidity. */
export function freeLiquidity(s: AllocatorState): bigint {
  const unborrowed = s.marketSupply > s.marketBorrow ? s.marketSupply - s.marketBorrow : 0n;
  return s.adapterAssets < unborrowed ? s.adapterAssets : unborrowed;
}

/** Safety margin kept under the caps: 1 ppm of vault assets, ~16 s of interest at Vault V2's 200% `maxRate`, for the
 * interest that accrues between reading the state and the transaction being mined. */
export const ROOM_MARGIN_PPM_DIVISOR = 1_000_000n;

/**
 * Room left under the absolute and relative caps (relative cap measured on totalAssets, as Vault V2 does). Vault V2
 * re-marks the allocation to the adapter's real (interest-accrued) assets on every `allocate`, so the current
 * allocation is the larger of the recorded one and `adapterAssets` (Phase 2 fix: the recorded value alone let a plan
 * exceed the relative cap by the interest accrued since the last allocation, reverting `RelativeCapExceeded`).
 */
export function allocationRoom(s: AllocatorState): bigint {
  const current = (s.adapterAssets > s.allocation ? s.adapterAssets : s.allocation) + s.totalAssets / ROOM_MARGIN_PPM_DIVISOR;
  const absRoom = s.absoluteCap > current ? s.absoluteCap - current : 0n;
  if (s.relativeCap >= WAD) return absRoom;
  const relLimit = (s.totalAssets * s.relativeCap) / WAD;
  const relRoom = relLimit > current ? relLimit - current : 0n;
  return absRoom < relRoom ? absRoom : relRoom;
}

export function planAllocation(s: AllocatorState, p: AllocatorParams): AllocatorAction {
  const free = freeLiquidity(s);
  if (s.pull) {
    // LM-R31: leave no borrowable liquidity while the guard is tripped or an earnings print is due.
    return free > 0n ? {kind: "deallocate", assets: free, reason: "pull: guard tripped or event window"} : {kind: "none", reason: "pull: nothing free"};
  }
  const idleTarget = (s.totalAssets * (WAD - p.uMax)) / WAD; // LM-R30: keep (1 − U_MAX) idle for withdrawals
  if (s.idle > idleTarget) {
    const want = s.idle - idleTarget;
    const room = allocationRoom(s);
    const amount = want < room ? want : room;
    return amount >= p.minMove ? {kind: "allocate", assets: amount, reason: "idle above reserve"} : {kind: "none", reason: "within band"};
  }
  const short = idleTarget - s.idle;
  const amount = short < free ? short : free;
  return amount >= p.minMove ? {kind: "deallocate", assets: amount, reason: "restore idle reserve"} : {kind: "none", reason: "within band"};
}
