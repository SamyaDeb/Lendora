import {etToUnix, isTradingDay, type YMD} from "@stockline/sdk";
import type {VaultOverview, VaultUser, VaultWindow, WithdrawPreview} from "./types";

/** DN-R1: queued withdrawals settle within 72 hours or at the next US market open, whichever is later. */
export const QUEUE_HOURS = 72;

/** The ET calendar day of a UTC timestamp (seconds). */
function etDay(ts: number): YMD {
  const p = new Intl.DateTimeFormat("en-US", {timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric"}).formatToParts(new Date(ts * 1000));
  const n = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return {year: n("year"), month: n("month"), day: n("day")};
}

/** The first NYSE regular open (09:30 ET on a trading day) strictly after `ts`. */
export function nextUsOpen(ts: number): number {
  let d = etDay(ts);
  for (let i = 0; i < 14; i++) {
    const open = etToUnix(d, 9, 30);
    if (open > ts && isTradingDay(d)) return open;
    const next = new Date(Date.UTC(d.year, d.month - 1, d.day + 1));
    d = {year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate()};
  }
  return ts + QUEUE_HOURS * 3600;
}

/** When a request made at `ts` is paid: max(ts + 72h, next US open). */
export function settleTime(ts: number): number {
  return Math.max(ts + QUEUE_HOURS * 3600, nextUsOpen(ts));
}

/** Instant part up to the cash buffer, the rest queued (the contract's split; fixtures and tests use this). */
export function splitWithdraw(assets: number, instantCapacity: number, now: number, instantPaused = false): WithdrawPreview {
  const a = Math.max(0, assets);
  const instant = instantPaused ? 0 : Math.min(a, Math.max(0, instantCapacity));
  const queued = Math.round((a - instant) * 1e6) / 1e6;
  return {instant, queued, settlesAt: queued > 0 ? new Date(settleTime(now) * 1000).toISOString() : undefined};
}

/** Value minus net deposits; unknown (undefined) until the deposits are indexed, never "everything is profit". */
export function earnings(u: Pick<VaultUser, "value" | "netDeposits">): number | undefined {
  return u.netDeposits > 0 ? u.value - u.netDeposits : undefined;
}

export const APY_KEY: Record<VaultWindow, keyof VaultOverview["apy"]> = {"7d": "d7", "30d": "d30", "90d": "d90"};

/** The yield split for a window; its parts add up to the headline APY (before rounding). */
export function splitFor(o: Pick<VaultOverview, "split">, w: VaultWindow) {
  return o.split.find((s) => s.window === w) ?? o.split[0];
}
export const splitTotal = (s: {lending: number; funding: number; buffer: number; costs: number}) => s.lending + s.funding + s.buffer + s.costs;

/** Largest absolute sleeve delta and lowest margin ratio over the active sleeves (the hedge status). */
export function hedgeStatus(o: Pick<VaultOverview, "sleeves">) {
  const active = o.sleeves.filter((s) => s.status === "active");
  const list = active.length ? active : o.sleeves;
  return {maxDelta: Math.max(0, ...list.map((s) => Math.abs(s.delta))), minMargin: Math.min(...list.map((s) => s.marginRatio))};
}

/** Why deposits are closed, in plain words (one sentence per pause reason; CP-R7: no promises). */
export const PAUSE_COPY: Record<NonNullable<VaultOverview["pauseReason"]>, string> = {
  cap_zero: "Deposits open after the simulation gate and audits.",
  cap_full: "The vault is full. Withdrawals work; deposits reopen when the cap rises.",
  nav_stale: "Deposits are paused while the vault's price data is more than 15 minutes old and markets are closed. They reopen with the next fresh report.",
  paused: "Deposits are paused by the vault's guardian. Withdrawals and claims still work.",
};
