import {describe, expect, it} from "vitest";
import {mulDivDown, mulDivUp, WAD} from "../src/math/wad.js";

describe("wad math", () => {
  it("rounds down and up like Solidity mulDiv", () => {
    expect(mulDivDown(10n, WAD, 3n * WAD)).toBe(3n);
    expect(mulDivUp(10n, WAD, 3n * WAD)).toBe(4n);
    expect(mulDivUp(9n, WAD, 3n * WAD)).toBe(3n);
    expect(mulDivUp(0n, WAD, 3n)).toBe(0n);
  });

  it("rejects division by zero", () => {
    expect(() => mulDivDown(1n, 1n, 0n)).toThrow(RangeError);
  });
});
