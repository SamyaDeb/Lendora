/**
 * US Eastern time → UTC, with DST handled here (never onchain, OR-R11).
 * Rule since 2007: EDT (UTC−4) from the second Sunday of March 02:00 local to the first Sunday of November 02:00 local;
 * EST (UTC−5) otherwise. Stockline only converts 17:00 and 20:00 ET, which are never ambiguous.
 */

/** Calendar date (no time zone). `month` is 1–12. */
export interface YMD {
  year: number;
  month: number;
  day: number;
}

const DAY_MS = 86_400_000;

/** Day of week, 0 = Sunday. */
export function weekday(d: YMD): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

export function addDays(d: YMD, n: number): YMD {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day) + n * DAY_MS);
  return {year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate()};
}

export function ymdKey(d: YMD): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

export function parseYmd(s: string): YMD {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad date ${s}`);
  return {year: Number(m[1]), month: Number(m[2]), day: Number(m[3])};
}

export function compareYmd(a: YMD, b: YMD): number {
  return Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
}

/** The n-th (1-based) given weekday of a month; n = -1 means the last one. */
export function nthWeekday(year: number, month: number, dow: number, n: number): YMD {
  if (n > 0) {
    const first = weekday({year, month, day: 1});
    return {year, month, day: 1 + ((dow - first + 7) % 7) + 7 * (n - 1)};
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = weekday({year, month, day: lastDay});
  return {year, month, day: lastDay - ((last - dow + 7) % 7)};
}

/** True if the given local ET wall time falls in daylight saving time. */
export function isEasternDst(d: YMD, hour: number): boolean {
  const start = nthWeekday(d.year, 3, 0, 2); // second Sunday of March, 02:00
  const end = nthWeekday(d.year, 11, 0, 1); // first Sunday of November, 02:00
  const c1 = compareYmd(d, start);
  const c2 = compareYmd(d, end);
  if (c1 < 0 || c2 > 0) return false;
  if (c1 === 0) return hour >= 2;
  if (c2 === 0) return hour < 2;
  return true;
}

/** Unix seconds (UTC) of `hour:minute` ET on date `d`. */
export function etToUnix(d: YMD, hour: number, minute = 0): number {
  const offsetHours = isEasternDst(d, hour) ? 4 : 5;
  return Date.UTC(d.year, d.month - 1, d.day, hour + offsetHours, minute) / 1000;
}
