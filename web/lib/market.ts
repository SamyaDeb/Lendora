import {U_MAX_WAD} from "@stockline/sdk";
import type {Market} from "./api";

/** U_MAX as a fraction (0.9): the Vault V2 utilization cap the allocator keeps each market under. */
export const U_MAX = Number(U_MAX_WAD) / 1e18;

export type Ease = "easy" | "tight" | "hard" | "paused";

/**
 * Borrow availability for the board. Not an API field: derived from utilization against U_MAX.
 * easy: < U_MAX − 25 pts (≥ 25 pts of headroom) · tight: up to U_MAX − 5 pts · hard: within 5 pts of the cap or above ·
 * paused: guard tripped.
 */
export function borrowEase(m: Pick<Market, "utilization" | "guard">, uMax = U_MAX): Ease {
  if (m.guard.tripped) return "paused";
  const u = Number(m.utilization);
  if (u >= uMax - 0.05) return "hard";
  if (u >= uMax - 0.25) return "tight";
  return "easy";
}

/** Stock still available to borrow (shares), keeping the market under U_MAX. */
export function availableToBorrow(m: Pick<Market, "supplied" | "borrowed">, uMax = U_MAX): number {
  return Math.max(0, Number(m.supplied) * uMax - Number(m.borrowed));
}

export interface BoardTotals {
  suppliedUsd: number;
  borrowedUsd: number;
  borrowers: number;
}

export function totals(ms: Market[]): BoardTotals {
  return ms.reduce(
    (a, m) => ({
      suppliedUsd: a.suppliedUsd + Number(m.supplied) * Number(m.price.usdPerShare),
      borrowedUsd: a.borrowedUsd + Number(m.borrowedUsd),
      borrowers: a.borrowers + m.borrowers,
    }),
    {suppliedUsd: 0, borrowedUsd: 0, borrowers: 0},
  );
}
