import {afterEach, describe, expect, it, vi} from "vitest";
import {cleanup, fireEvent, render} from "@testing-library/react";
import {FX_MARKETS, FX_MARKETS_PAUSED, fxHistory} from "@/lib/fixtures";
import {borrowEase} from "@/lib/market";
import {sessionFromMarkets, countdown} from "@/lib/session";
import {MarketsBoardView} from "@/components/markets/MarketsBoardView";
import {SessionBarView} from "@/components/shell/SessionBar";
import {HealthMeter} from "@/components/ui";

vi.mock("next/navigation", () => ({useRouter: () => ({push: vi.fn()}), usePathname: () => "/"}));
afterEach(cleanup);

const hist = Object.fromEntries(FX_MARKETS.map((m, i) => [m.symbol, fxHistory(m, 48, i + 1)]));
const W = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

describe("markets board (fixtures)", () => {
  it("sorts by utilization, highest first, and labels borrow availability", () => {
    const {getByTestId} = render(<MarketsBoardView markets={FX_MARKETS} histories={hist} />);
    const table = getByTestId("markets");
    const utils = [...table.querySelectorAll('[data-col="utilization"]')].map((e) => Number(e.textContent!.replace("%", "")));
    expect([...utils].sort((a, b) => b - a)).toEqual(utils);
    expect(table.textContent).toContain("Hard to borrow"); // SPY at 91% ≥ U_MAX − 5 pts
    expect(table.textContent).toContain("Easy to borrow"); // AAPL at 36%
  });

  it("search with no match shows an empty state with a way back", () => {
    const {getByPlaceholderText, getByText} = render(<MarketsBoardView markets={FX_MARKETS} histories={hist} />);
    fireEvent.change(getByPlaceholderText("Search a ticker"), {target: {value: "TSLA"}});
    expect(getByText("No stock matches “TSLA”")).toBeTruthy();
    expect(getByText("Show all markets")).toBeTruthy();
  });

  it("loading renders a skeleton (no spinner); error says what happened", () => {
    const loading = render(<MarketsBoardView histories={{}} />);
    expect(loading.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    const error = render(<MarketsBoardView histories={{}} error />);
    expect(error.container.textContent).toContain("Market data didn't load");
  });

  it("guard tripped means borrowing paused", () => {
    expect(borrowEase(FX_MARKETS_PAUSED[0])).toBe("paused");
  });
});

describe("session", () => {
  it("weekend mode when any market is closed; shows the buffer and countdown", () => {
    const view = sessionFromMarkets(FX_MARKETS.map((m) => ({...m, marketStatus: "closed", buffer: "0.101"})), 1_791_663_552);
    expect(view.state).toBe("weekend");
    const {container} = render(<SessionBarView view={{...view, nextTs: 1_791_663_552 + 3600 * 5}} now={1_791_663_552} />);
    expect(container.textContent).toContain("Weekend mode, higher collateral required");
    expect(container.textContent).toContain("10.1%");
    expect(countdown(1_791_663_552 + 3600 * 5 + 120, 1_791_663_552)).toBe("5h 02m");
  });
});

describe("health meter", () => {
  it("pairs color with a word and says liquidation is at 1.00", () => {
    expect(render(<HealthMeter hf={W(1.04)} />).container.textContent).toContain("Close to liquidation");
    expect(render(<HealthMeter hf={W(1.3)} />).container.textContent).toContain("At risk");
    expect(render(<HealthMeter hf={W(2)} />).container.textContent).toContain("Liquidation at 1.00");
  });
});
