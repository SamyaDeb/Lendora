import {isTradingDay, nyseEarlyCloses} from "./nyse.js";
import {addDays, compareYmd, etToUnix, ymdKey, type YMD} from "./time.js";

/** One Chainlink 24/5 feed session, UTC seconds (matches `IMarketHours.Session`). */
export interface Session {
  openTs: number;
  closeTs: number;
}

/** Hour (ET) at which the 24/5 feed day ends: 20:00 normally, 17:00 on NYSE early-close days (A9). */
export const FEED_DAY_END_HOUR = 20;
export const EARLY_CLOSE_FEED_END_HOUR = 17;

/**
 * Feed sessions covering trading days `from`..`to` (inclusive), per D2 and the Phase 0 feed data:
 * trading day D is live from D−1 20:00 ET to D 20:00 ET (17:00 ET on early-close days, A9). Weekends and NYSE holidays
 * are frozen. Consecutive trading days whose windows touch merge into one session (Sunday 20:00 → Friday 20:00).
 */
export function generateSessions(from: YMD, to: YMD): Session[] {
  const out: Session[] = [];
  for (let d = from; compareYmd(d, to) <= 0; d = addDays(d, 1)) {
    if (!isTradingDay(d)) continue;
    const openTs = etToUnix(addDays(d, -1), FEED_DAY_END_HOUR);
    const early = nyseEarlyCloses(d.year).has(ymdKey(d));
    const closeTs = etToUnix(d, early ? EARLY_CLOSE_FEED_END_HOUR : FEED_DAY_END_HOUR);
    const last = out[out.length - 1];
    if (last && last.closeTs === openTs) last.closeTs = closeTs;
    else out.push({openTs, closeTs});
  }
  return out;
}

/** The session containing `t` (open ≤ t < close), or undefined. */
export function sessionAt(sessions: Session[], t: number): Session | undefined {
  let lo = 0;
  let hi = sessions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sessions[mid].closeTs <= t) lo = mid + 1;
    else hi = mid;
  }
  const s = sessions[lo];
  return s && s.openTs <= t ? s : undefined;
}
