import {describe, expect, it} from "vitest";
import {isUsRegularHours} from "../src/calendar/nyse.js";

const utc = (s: string) => Date.parse(s) / 1000;

describe("isUsRegularHours (FE-R4 keeper scheduling)", () => {
  it("09:30–16:00 ET on trading days, DST-aware", () => {
    expect(isUsRegularHours(utc("2026-09-28T13:29:59Z"))).toBe(false); // 09:29:59 EDT
    expect(isUsRegularHours(utc("2026-09-28T13:30:00Z"))).toBe(true);
    expect(isUsRegularHours(utc("2026-09-28T19:59:59Z"))).toBe(true);
    expect(isUsRegularHours(utc("2026-09-28T20:00:00Z"))).toBe(false); // 16:00 EDT
    expect(isUsRegularHours(utc("2026-12-01T14:30:00Z"))).toBe(true); // 09:30 EST
    expect(isUsRegularHours(utc("2026-12-01T14:29:00Z"))).toBe(false);
  });

  it("weekends, holidays and early closes", () => {
    expect(isUsRegularHours(utc("2026-09-26T15:00:00Z"))).toBe(false); // Saturday
    expect(isUsRegularHours(utc("2026-11-26T16:00:00Z"))).toBe(false); // Thanksgiving
    expect(isUsRegularHours(utc("2026-11-27T17:59:00Z"))).toBe(true); // 12:59 EST, early close day
    expect(isUsRegularHours(utc("2026-11-27T18:00:00Z"))).toBe(false); // 13:00 EST
  });
});
