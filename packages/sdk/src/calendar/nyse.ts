import {addDays, nthWeekday, weekday, ymdKey, type YMD} from "./time.js";

/**
 * NYSE full-day holidays and 13:00 ET early closes, by rule (NYSE Rule 7.2 holiday practice).
 * Observance: a Saturday holiday moves to Friday, a Sunday holiday to Monday; New Year's Day on a Saturday is not
 * observed. `SPECIAL_CLOSURES` lists one-off closures (e.g. national days of mourning).
 */

/** Unscheduled full-day closures announced by NYSE. */
export const SPECIAL_CLOSURES: Record<string, string> = {
  "2025-01-09": "National Day of Mourning (President Carter)",
};

/** Western (Gregorian) Easter Sunday, anonymous algorithm. */
export function easterSunday(year: number): YMD {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return {year, month, day};
}

function observed(d: YMD): YMD {
  const w = weekday(d);
  if (w === 6) return addDays(d, -1);
  if (w === 0) return addDays(d, 1);
  return d;
}

/** Full-day NYSE holidays of `year`, keyed `YYYY-MM-DD` → name. */
export function nyseHolidays(year: number): Map<string, string> {
  const out = new Map<string, string>();
  const add = (d: YMD, name: string) => {
    if (d.year === year) out.set(ymdKey(d), name);
  };
  const ny: YMD = {year, month: 1, day: 1};
  if (weekday(ny) !== 6) add(observed(ny), "New Year's Day");
  add(nthWeekday(year, 1, 1, 3), "Martin Luther King Jr. Day");
  add(nthWeekday(year, 2, 1, 3), "Washington's Birthday");
  add(addDays(easterSunday(year), -2), "Good Friday");
  add(nthWeekday(year, 5, 1, -1), "Memorial Day");
  if (year >= 2022) add(observed({year, month: 6, day: 19}), "Juneteenth");
  add(observed({year, month: 7, day: 4}), "Independence Day");
  add(nthWeekday(year, 9, 1, 1), "Labor Day");
  add(nthWeekday(year, 11, 4, 4), "Thanksgiving Day");
  add(observed({year, month: 12, day: 25}), "Christmas Day");
  for (const [k, v] of Object.entries(SPECIAL_CLOSURES)) if (k.startsWith(`${year}-`)) out.set(k, v);
  return out;
}

/** 13:00 ET early closes of `year`, keyed `YYYY-MM-DD` → reason. */
export function nyseEarlyCloses(year: number): Map<string, string> {
  const out = new Map<string, string>();
  const holidays = nyseHolidays(year);
  const isTrading = (d: YMD) => weekday(d) !== 0 && weekday(d) !== 6 && !holidays.has(ymdKey(d));
  const jul3: YMD = {year, month: 7, day: 3};
  if (weekday(jul3) >= 1 && weekday(jul3) <= 4 && isTrading(jul3)) out.set(ymdKey(jul3), "Day before Independence Day");
  out.set(ymdKey(addDays(nthWeekday(year, 11, 4, 4), 1)), "Day after Thanksgiving");
  const dec24: YMD = {year, month: 12, day: 24};
  if (isTrading(dec24)) out.set(ymdKey(dec24), "Christmas Eve");
  return out;
}

/** A US equity trading day (weekday, not an NYSE holiday). */
export function isTradingDay(d: YMD): boolean {
  const w = weekday(d);
  return w !== 0 && w !== 6 && !nyseHolidays(d.year).has(ymdKey(d));
}
