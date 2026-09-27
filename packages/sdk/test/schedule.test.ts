import {describe, expect, it} from "vitest";
import {feedSessions, nextClosure, nextEvent} from "../src/calendar/schedule.js";

const params = {z: 25n * 10n ** 17n, sigma: 52n * 10n ** 16n, bMin: 10n ** 16n, bMax: 2n * 10n ** 17n, rampIn: 4n * 3600n};
const WED = 1_790_784_000; // Wed 2026-09-30 16:00Z

describe("feed schedule (06 preview countdown, 07 market detail)", () => {
  it("OR-R11 the calendar data spans the Phase 2 period", () => {
    expect(feedSessions.length).toBeGreaterThan(70);
    expect(feedSessions[feedSessions.length - 1].closeTs).toBeGreaterThan(WED + 365 * 86_400);
  });

  it("OR-R20 midweek: next close is Friday 20:00 ET, ramp starts 16:00 ET, NVDA weekend b_full ≈ 9.6%", () => {
    const c = nextClosure(WED, params)!;
    expect(c.open).toBe(true);
    expect(new Date(c.closeTs * 1000).toISOString()).toBe("2026-10-03T00:00:00.000Z");
    expect(c.rampStartTs).toBe(c.closeTs - 4 * 3600);
    expect(c.closureSeconds).toBe(48 * 3600);
    expect(Number(c.bufferAtClose) / 1e18).toBeCloseTo(0.096, 3);
  });

  it("OR-R20 during the weekend: the closure in progress and its reopen", () => {
    const sat = WED + 3 * 86_400;
    const c = nextClosure(sat, params)!;
    expect(c.open).toBe(false);
    expect(new Date(c.reopenTs * 1000).toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("D5 next earnings window per ticker", () => {
    expect(nextEvent("NVDA", WED)?.endTs).toBeGreaterThan(BigInt(WED));
    expect(nextEvent("SPY", WED)).toBeUndefined();
  });
});
