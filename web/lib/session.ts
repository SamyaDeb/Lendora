import {feedSessions, type Session} from "@lendora/sdk";
import type {Market} from "./api";

/**
 * The market session the whole app shows (the session bar, the accent, weekend buffers).
 * "open": price feed live. "ramping": the weekend buffer is ramping in before the close. "weekend": feed closed
 * (weekend or holiday), the oracle adds the full safety buffer. The API's per-market status is authoritative; the
 * calendar (the same data as the onchain MarketHours) gives the countdown.
 */
export type SessionState = "open" | "ramping" | "weekend";

export interface SessionView {
  state: SessionState;
  /** The next change: close (when open or ramping) or reopen (when closed), UTC seconds. */
  nextTs?: number;
  /** Buffer in force now (0–1), the largest across markets. */
  buffer: number;
  paused: string[];
}

export function sessionFromMarkets(ms: Market[] | undefined, now: number, sessions: Session[] = feedSessions): SessionView {
  const list = ms ?? [];
  const statuses = list.map((m) => m.marketStatus);
  const cal = calendarAt(now, sessions);
  // Market status first; a guard-tripped market says nothing about the session, so fall back to the calendar.
  const state: SessionState = statuses.includes("closed") ? "weekend" : statuses.includes("ramping") ? "ramping" : statuses.includes("open") ? "open" : cal.open ? "open" : "weekend";
  const buffer = Math.max(0, ...list.map((m) => Number(m.buffer)));
  return {state, nextTs: state === "weekend" ? cal.reopenTs : cal.closeTs, buffer, paused: list.filter((m) => m.guard.tripped).map((m) => m.symbol)};
}

/** Whether the feed is open at `now`, and the next close / reopen from the calendar. */
export function calendarAt(now: number, sessions: Session[] = feedSessions): {open: boolean; closeTs?: number; reopenTs?: number} {
  const i = sessions.findIndex((s) => s.closeTs > now);
  if (i < 0) return {open: false};
  const s = sessions[i];
  const open = s.openTs <= now;
  return open ? {open, closeTs: s.closeTs, reopenTs: sessions[i + 1]?.openTs} : {open, reopenTs: s.openTs, closeTs: s.closeTs};
}

/** "2d 4h", "3h 12m", "12m 05s" until `ts`. */
export function countdown(ts: number, now: number): string {
  let s = Math.max(0, Math.floor(ts - now));
  const d = Math.floor(s / 86_400);
  s -= d * 86_400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}
