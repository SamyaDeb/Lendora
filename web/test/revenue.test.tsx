import {describe, expect, it} from "vitest";
import {render} from "@testing-library/react";
import type {api} from "@stockline/sdk";
import {RevenuePanel} from "@/components/RevenuePanel";

const body = (bySymbol: api.RevenueResponse["data"]["totals"]["bySymbol"]): api.RevenueResponse =>
  ({
    asOfBlock: "10",
    asOfTime: "2026-10-01T16:00:00.000Z",
    confirmed: false,
    safe: false,
    scope: "Stockline markets only",
    from: "2026-07-03T00:00:00.000Z",
    to: "2026-10-01T23:59:59.000Z",
    rateKind: "variable",
    data: {days: [], totals: {feeUsd: "12.5", bySymbol}, distributed: {count: 2, usd: "10"}, converted: {count: 1, usdg: "9.95", usd: "9.95"}},
  }) as api.RevenueResponse;

describe("FE-R5 protocol revenue on the dashboard", () => {
  it("shows fees per stock in stock units and USD, with CP-R7 wording", () => {
    const {container, getByTestId} = render(<RevenuePanel revenue={body([{symbol: "NVDA", fee: "0.055", feeUsd: "12.5", raw: {feeShares: "1", feeAssets: "55000000000000000"}}])} />);
    expect(container.textContent).toContain("historical");
    expect(container.textContent).toContain("variable");
    expect(container.textContent).toContain("NVDA");
    expect(getByTestId("revenue-total").textContent).toContain("12.5");
    expect(container.textContent).toContain("9.95 USDG");
    expect(container.textContent).not.toMatch(/guarantee|will earn/i);
  });

  it("empty and unavailable states", () => {
    expect(render(<RevenuePanel revenue={body([])} />).container.textContent).toContain("No fees accrued");
    expect(render(<RevenuePanel revenue={undefined} />).container.textContent).toContain("not available");
  });
});
