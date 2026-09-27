import {describe, expect, it} from "vitest";
import {render} from "@testing-library/react";
import {HealthFactor, StatusBadge, StepList} from "@/components/ui";

const W = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

describe("UI primitives", () => {
  it("APP-R6 health factor colors: ≥1.5 green, 1.1–1.5 amber, <1.1 red; says liquidation at 1.00", () => {
    const tone = (hf: number) => render(<HealthFactor hf={W(hf)} />).container.querySelector("[data-hf-tone]")!.getAttribute("data-hf-tone");
    expect(tone(2)).toBe("safe");
    expect(tone(1.5)).toBe("safe");
    expect(tone(1.49)).toBe("warn");
    expect(tone(1.1)).toBe("warn");
    expect(tone(1.09)).toBe("danger");
    const {container} = render(<HealthFactor hf={W(1.05)} />);
    expect(container.textContent).toContain("liquidation at 1.00");
    expect(render(<HealthFactor hf={2n ** 256n - 1n} />).container.textContent).toContain("∞");
  });

  it("06 market statuses have distinct labels", () => {
    for (const [s, label] of [["open", "Open"], ["closed", "Closed · weekend mode"], ["ramping", "Weekend buffer ramping"], ["guard_tripped", "Guard tripped"]]) {
      expect(render(<StatusBadge status={s} />).container.textContent).toBe(label);
    }
  });

  it("APP-R3 step list shows every step with its status and the failure reason", () => {
    const {container} = render(
      <StepList
        steps={[
          {id: "a", label: "Approve USDG", kind: "approve", status: "skipped"},
          {id: "b", label: "Borrow", kind: "execute", status: "failed", detail: "Not enough collateral"},
        ]}
      />,
    );
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.textContent).toContain("Not enough collateral");
    expect(container.querySelector('[data-status="failed"]')).not.toBeNull();
  });
});
