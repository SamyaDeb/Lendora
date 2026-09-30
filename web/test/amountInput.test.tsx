import {describe, expect, it} from "vitest";
import {fireEvent, render, screen} from "@testing-library/react";
import {useState} from "react";
import {AmountInput, parseAmount} from "../components/ui/AmountInput";

/** 46630 browser pass (break: inputs). The vault's own hint says "Enter a number, like 1,000 or 12.5". */
describe("T27 amounts as people type and paste them", () => {
  it("a comma thousands separator is thousands, not a decimal point (\"1,000\" was read as 1)", () => {
    expect(parseAmount("1,000", 6)).toBe(1_000_000_000n);
    expect(parseAmount("12,345,678.9", 6)).toBe(12_345_678_900_000n);
    expect(parseAmount("1 000", 6)).toBe(1_000_000_000n);
    expect(parseAmount(" 2 500.5 ", 6)).toBe(2_500_500_000n);
  });
  it("a lone comma with other than three digits after it is a decimal comma", () => {
    expect(parseAmount("12,5", 6)).toBe(12_500_000n);
    expect(parseAmount("0,25", 18)).toBe(25n * 10n ** 16n);
  });
  it("junk is refused: negative, exponent, two points, letters, non-ASCII digits, misplaced separators", () => {
    for (const s of ["-1", "1e-30", "1e30", "1.2.3", "abc", "١٢", "1,00,000", ",5.", "."]) expect(parseAmount(s, 6), s).toBeUndefined();
  });
  it("more decimals than the token has is refused, not silently rounded (0.0000005 USDG became 0.000001)", () => {
    expect(parseAmount("0.0000005", 6)).toBeUndefined();
    expect(parseAmount("1.123456", 6)).toBe(1_123_456n);
    expect(parseAmount("0.000000000000000001", 18)).toBe(1n);
  });
  it("leading zeros are fine; zero parses to 0 (the flows refuse it)", () => {
    expect(parseAmount("007.5", 6)).toBe(7_500_000n);
    expect(parseAmount("0", 6)).toBe(0n);
  });
  it("the field keeps what was typed (typing 1,000 key by key ends as 1,000 = 1000 USDG) and says why a value is refused", () => {
    function Harness() {
      const [v, setV] = useState("");
      return <AmountInput label="Amount" value={v} onChange={setV} decimals={6} unit="USDG" usdPrice={1} testId="a" />;
    }
    render(<Harness />);
    const input = screen.getByTestId("a") as HTMLInputElement;
    for (const s of ["1", "1,", "1,0", "1,00", "1,000"]) fireEvent.change(input, {target: {value: s}});
    expect(input.value).toBe("1,000");
    expect(screen.getByText("≈ $1,000.00")).toBeTruthy();
    fireEvent.change(input, {target: {value: "0.0000005"}});
    expect(screen.getByRole("alert").textContent).toMatch(/6 decimal places/);
  });
  it("T40 over the max reads once: \"more than your balance\" (was \"your your balance\")", () => {
    render(<AmountInput label="Amount" value="5" onChange={() => {}} decimals={6} unit="USDG" max={1_000_000n} maxLabel="Your balance" />);
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toContain("That's more than your balance.");
  });
});
