import {describe, expect, it} from "vitest";
import {render, screen} from "@testing-library/react";
import {DataDelayed, delayMinutes} from "../components/ui/DataDelayed";

/** 46630 browser pass (break: the indexer lagging): pages kept showing hours-old API data as current (T28). */
describe("T28 the app says when API data is delayed", () => {
  const now = Date.parse("2026-09-30T20:05:00Z");
  it("minutes behind the wall clock, only past two minutes", () => {
    expect(delayMinutes("2026-09-30T20:04:10Z", now)).toBeUndefined();
    expect(delayMinutes("2026-09-30T18:15:00Z", now)).toBe(110);
    expect(delayMinutes(undefined, now)).toBeUndefined();
  });
  it("renders a plain notice with the age, and nothing when fresh", () => {
    const {unmount} = render(<DataDelayed asOfTime="2026-09-30T18:15:00Z" now={now} />);
    const n = screen.getByTestId("data-delayed");
    expect(n.textContent).toMatch(/1 h 50 min old/);
    expect(n.textContent).toMatch(/read the chain directly/);
    unmount();
    render(<DataDelayed asOfTime="2026-09-30T20:04:30Z" now={now} />);
    expect(screen.queryByTestId("data-delayed")).toBeNull();
  });
});
