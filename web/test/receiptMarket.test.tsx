import {afterEach, describe, expect, it, vi} from "vitest";
import {cleanup, render, screen} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";

vi.mock("@/lib/api", () => ({
  browserApi: () => ({
    receiptMarkets: async () => ({data: [{symbol: "NVDA", listed: false, lltv: "0.625", supplied: "1", borrowed: "0", utilization: "0"}]}),
  }),
}));

import {ReceiptMarketPanel} from "@/components/stock/ReceiptMarket";

afterEach(cleanup);

describe("A3 receipt market panel (CL-R10, CL-R12)", () => {
  it("shows LLTV, the not-listed state and the recursion risk; nothing for a stock without a receipt market", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ReceiptMarketPanel symbol="NVDA" />
        <ReceiptMarketPanel symbol="SPY" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("62.5%")).toBeTruthy();
    expect(screen.getByText("Not listed yet")).toBeTruthy();
    expect(screen.getByTestId("receipt-not-listed").textContent).toMatch(/48-hour curator timelock, at least 30 days/);
    expect(screen.getByTestId("receipt-market").textContent).toMatch(/can.t return liquidity/);
    expect(screen.getAllByTestId("receipt-market")).toHaveLength(1);
  });
});
