import calendar from "../../data/calendar.json" with {type: "json"};
import type {Session} from "./sessions.js";
import {fullBuffer, type BufferConfig, type BufferParams, type EventWindowBig} from "../math/oracle.js";

/**
 * The feed calendar the deploy scripts push to `MarketHours` (data/calendar.json, OR-R11), plus the schedule views
 * the app and API show: next closure, ramp-in start and the buffer at the close (06 preview panel, 07 market detail).
 * Onchain `MarketHours` is authoritative; this is the same data.
 */
export const feedSessions: Session[] = calendar.sessions.map((s) => ({openTs: s.openTs, closeTs: s.closeTs}));

/** Event windows per ticker from data/calendar.json (D5). */
export const eventWindowsByTickerData: Record<string, EventWindowBig[]> = Object.fromEntries(
  Object.entries(calendar.events as Record<string, {startTs: number; endTs: number; bufferWad: string}[]>).map(([t, list]) => [
    t,
    list.map((e) => ({startTs: BigInt(e.startTs), endTs: BigInt(e.endTs), bufferWad: BigInt(e.bufferWad)})),
  ]),
);

/** `BufferConfig` for a ticker from the calendar data and the oracle's params (read from chain). */
export function bufferConfigFor(ticker: string, params: BufferParams, floor = 0n): BufferConfig {
  return {params, sessions: feedSessions, events: eventWindowsByTickerData[ticker] ?? [], floor};
}

export interface NextClosure {
  /** Whether the feed session is open at `now`. */
  open: boolean;
  /** Close of the current (or next) session, UTC seconds. */
  closeTs: number;
  /** Reopen after that close (0 = beyond the stored calendar). */
  reopenTs: number;
  /** When the closure buffer starts ramping in (`closeTs − rampIn`). */
  rampStartTs: number;
  /** Closure length in seconds (MAX_CLOSURE if unknown). */
  closureSeconds: number;
  /** `b_full` for that closure (WAD). */
  bufferAtClose: bigint;
}

/** The next feed closure after `now` (or the one in progress) and its full buffer. Undefined past the calendar. */
export function nextClosure(now: number, params: BufferParams, sessions: Session[] = feedSessions): NextClosure | undefined {
  const i = sessions.findIndex((s) => s.closeTs > now);
  if (i < 0) return undefined;
  const s = sessions[i];
  const open = s.openTs <= now;
  // In a closure (before s.openTs), the closure in progress is the one that ends at s.openTs.
  const closeTs = open ? s.closeTs : i > 0 ? sessions[i - 1].closeTs : s.openTs;
  const reopenTs = open ? (sessions[i + 1]?.openTs ?? 0) : s.openTs;
  const closureSeconds = reopenTs ? reopenTs - closeTs : 96 * 3600;
  return {
    open,
    closeTs,
    reopenTs,
    rampStartTs: closeTs - Number(params.rampIn),
    closureSeconds,
    bufferAtClose: fullBuffer(params.z, params.sigma, params.bMin, params.bMax, BigInt(closureSeconds)),
  };
}

/** The next scheduled event window of `ticker` whose release is after `now` (D5), if any. */
export function nextEvent(ticker: string, now: number): EventWindowBig | undefined {
  return (eventWindowsByTickerData[ticker] ?? []).find((e) => e.endTs > BigInt(now));
}
