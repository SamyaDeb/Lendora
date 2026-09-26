import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {eventWindowsByTicker, toEventWindow, type EventsFile} from "../src/calendar/events.js";
import {easterSunday, isTradingDay, nyseEarlyCloses, nyseHolidays} from "../src/calendar/nyse.js";
import {generateSessions, sessionAt} from "../src/calendar/sessions.js";
import {addDays, etToUnix, parseYmd, ymdKey} from "../src/calendar/time.js";

/** ET wall time of a unix timestamp via Intl (independent of our DST rule). */
function intlEt(t: number): string {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return f.format(new Date(t * 1000)).replace(",", "");
}

describe("DST (OR-R11: handled in TS)", () => {
  it("matches Intl America/New_York at 17:00 and 20:00 ET for every day 2024-2030", () => {
    for (let d = parseYmd("2024-01-01"); d.year < 2031; d = addDays(d, 1)) {
      for (const h of [17, 20]) {
        expect(intlEt(etToUnix(d, h))).toBe(`${ymdKey(d)} ${h}:00`);
      }
    }
  });

  it("switch weeks: Sunday 20:00 ET is 00:00Z in EDT and 01:00Z in EST", () => {
    expect(new Date(etToUnix(parseYmd("2026-03-08"), 20) * 1000).toISOString()).toBe("2026-03-09T00:00:00.000Z");
    expect(new Date(etToUnix(parseYmd("2026-03-01"), 20) * 1000).toISOString()).toBe("2026-03-02T01:00:00.000Z");
    expect(new Date(etToUnix(parseYmd("2026-11-01"), 20) * 1000).toISOString()).toBe("2026-11-02T01:00:00.000Z");
    expect(new Date(etToUnix(parseYmd("2026-10-25"), 20) * 1000).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });
});

describe("NYSE calendar", () => {
  it("2026 holidays", () => {
    expect([...nyseHolidays(2026).keys()].sort()).toEqual([
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
      "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    ]);
  });

  it("2027 holidays with Saturday observance (Juneteenth, Christmas on Friday)", () => {
    expect([...nyseHolidays(2027).keys()].sort()).toEqual([
      "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
      "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
    ]);
  });

  it("New Year's Day on a Saturday is not observed (2022), special closures are included (2025-01-09)", () => {
    expect(nyseHolidays(2021).has("2021-12-31")).toBe(false);
    expect(nyseHolidays(2022).has("2022-01-01")).toBe(false);
    expect(nyseHolidays(2025).has("2025-01-09")).toBe(true);
  });

  it("early closes", () => {
    expect([...nyseEarlyCloses(2026).keys()].sort()).toEqual(["2026-11-27", "2026-12-24"]);
    expect([...nyseEarlyCloses(2025).keys()].sort()).toEqual(["2025-07-03", "2025-11-28", "2025-12-24"]);
    expect([...nyseEarlyCloses(2027).keys()].sort()).toEqual(["2027-11-26"]);
  });

  it("Easter", () => {
    expect(ymdKey(easterSunday(2026))).toBe("2026-04-05");
    expect(ymdKey(easterSunday(2027))).toBe("2027-03-28");
    expect(ymdKey(easterSunday(2000))).toBe("2000-04-23");
  });

  it("trading days", () => {
    expect(isTradingDay(parseYmd("2026-07-03"))).toBe(false);
    expect(isTradingDay(parseYmd("2026-07-02"))).toBe(true);
    expect(isTradingDay(parseYmd("2026-09-26"))).toBe(false);
  });
});

describe("feed sessions (D2)", () => {
  const sessions = generateSessions(parseYmd("2026-06-22"), parseYmd("2027-12-31"));
  const et = (s: string, h: number, m = 0) => etToUnix(parseYmd(s), h, m);

  it("are ordered, non-empty and separated by closures", () => {
    for (let i = 0; i < sessions.length; i++) {
      expect(sessions[i].openTs).toBeLessThan(sessions[i].closeTs);
      if (i > 0) expect(sessions[i].openTs).toBeGreaterThan(sessions[i - 1].closeTs);
    }
  });

  it("normal week: Sunday 20:00 ET to Friday 20:00 ET", () => {
    expect(sessionAt(sessions, et("2026-09-15", 12))).toEqual({openTs: et("2026-09-13", 20), closeTs: et("2026-09-18", 20)});
  });

  it("holiday Friday (2026-07-03) is frozen from Thursday 20:00 ET", () => {
    expect(sessionAt(sessions, et("2026-07-01", 12))!.closeTs).toBe(et("2026-07-02", 20));
    expect(sessionAt(sessions, et("2026-07-03", 12))).toBeUndefined();
  });

  it("Labor Day (Monday) is frozen until Monday 20:00 ET, as observed on 2026-09-07", () => {
    expect(sessionAt(sessions, et("2026-09-07", 19, 59))).toBeUndefined();
    expect(sessionAt(sessions, et("2026-09-07", 20))!.openTs).toBe(et("2026-09-07", 20));
  });

  it("Good Friday 2027 gives a 72h closure", () => {
    const s = sessionAt(sessions, et("2027-03-25", 12))!;
    expect(s.closeTs).toBe(et("2027-03-25", 20));
    const next = sessions[sessions.indexOf(s) + 1];
    expect(next.openTs - s.closeTs).toBe(72 * 3600);
  });

  it("Thanksgiving: Wednesday close, Friday 17:00 ET early close (A9), then the weekend", () => {
    expect(sessionAt(sessions, et("2026-11-25", 12))!.closeTs).toBe(et("2026-11-25", 20));
    expect(sessionAt(sessions, et("2026-11-26", 12))).toBeUndefined();
    expect(sessionAt(sessions, et("2026-11-27", 12))).toEqual({openTs: et("2026-11-26", 20), closeTs: et("2026-11-27", 17)});
  });

  it("DST switch week: the Sunday open moves from 01:00Z to 00:00Z", () => {
    // DST starts Sunday 2027-03-14 02:00 ET: that evening's 20:00 ET open is 00:00Z; the week before opens at 01:00Z.
    expect(sessionAt(sessions, et("2027-03-10", 12))!.openTs).toBe(Date.UTC(2027, 2, 8, 1) / 1000);
    expect(sessionAt(sessions, et("2027-03-17", 12))!.openTs).toBe(Date.UTC(2027, 2, 15, 0) / 1000);
    // ...and the closure spanning the switch is one hour shorter (47h).
    const s = sessionAt(sessions, et("2027-03-10", 12))!;
    expect(sessions[sessions.indexOf(s) + 1].openTs - s.closeTs).toBe(47 * 3600);
  });
});

describe("generator vs observed Chainlink rounds (sim/data/feeds, 2026-06-21 → 2026-09-26)", () => {
  const sessions = generateSessions(parseYmd("2026-06-22"), parseYmd("2026-12-31"));
  const rounds: number[] = [];
  for (const t of ["SPY", "NVDA", "AAPL"]) {
    const rows = readFileSync(new URL(`../../../sim/data/feeds/${t}.csv`, import.meta.url), "utf8").trim().split("\n").slice(1);
    for (const r of rows) rounds.push(Number(r.split(",")[3]));
  }
  rounds.sort((a, b) => a - b);
  const last = rounds[rounds.length - 1];

  it("every observed round lies inside a generated session (closures have no rounds)", () => {
    expect(rounds.length).toBeGreaterThan(1900);
    for (const u of rounds) expect(sessionAt(sessions, u), new Date(u * 1000).toISOString()).toBeDefined();
  });

  it("every generated session in the data window saw a round within 2 minutes of its open", () => {
    let checked = 0;
    for (const s of sessions) {
      if (s.closeTs > last) break;
      const first = rounds.find((u) => u >= s.openTs)!;
      expect(first - s.openTs, new Date(s.openTs * 1000).toISOString()).toBeLessThan(120);
      checked++;
    }
    expect(checked).toBe(13);
  });
});

describe("events.json (D5)", () => {
  const file: EventsFile = JSON.parse(readFileSync(new URL("../data/events.json", import.meta.url), "utf8"));

  it("has a documented source per event and valid windows", () => {
    for (const e of file.events) {
      expect(e.source.length).toBeGreaterThan(10);
      const w = toEventWindow(e);
      expect(w.endTs - w.startTs).toBe(e.holdHours * 3600);
    }
    const byTicker = eventWindowsByTicker(file);
    expect(byTicker.SPY).toBeUndefined();
    expect(byTicker.NVDA[0].bufferWad).toBeGreaterThanOrEqual(10n ** 17n);
    expect(byTicker.AAPL[0].bufferWad).toBeGreaterThanOrEqual(8n * 10n ** 16n);
    expect(new Date(byTicker.NVDA[0].endTs * 1000).toISOString()).toBe("2026-11-17T21:20:00.000Z");
  });

  it("rejects out-of-range buffers", () => {
    expect(() => toEventWindow({...file.events[0], bufferWad: "300000000000000000"})).toThrow();
    expect(() => toEventWindow({...file.events[0], holdHours: -1})).toThrow();
  });
});
