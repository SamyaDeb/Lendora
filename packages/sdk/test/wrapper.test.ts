import {describe, expect, it} from "vitest";
import {underlyingEquivalent} from "../src/math/wrapper.js";

// Same vectors as test_LM_R3_underlyingEquivalent in contracts/test/StockWrapper/StockWrapper.t.sol.
describe("LM-R3 underlyingEquivalent", () => {
  it("applies the multiplier and rounds down like the contract", () => {
    expect(underlyingEquivalent(10n * 10n ** 18n, 15n * 10n ** 17n)).toBe(15n * 10n ** 18n);
    expect(underlyingEquivalent(1n, 333_333_333_333_333_333n)).toBe(0n);
    expect(underlyingEquivalent(3n * 10n ** 18n, 333_333_333_333_333_333n)).toBe(999_999_999_999_999_999n);
  });

  it("is identity at multiplier 1.0", () => {
    expect(underlyingEquivalent(123_456_789n, 10n ** 18n)).toBe(123_456_789n);
  });
});
