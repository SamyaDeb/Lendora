import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {morphoEventsAbi} from "../src/morphoEvents.js";

const SOURCE = new URL("../../../contracts/lib/morpho-blue/src/libraries/EventsLib.sol", import.meta.url);

/** `event Name(Type [indexed] name, ...)` declarations from the Solidity source, comments stripped. */
function solidityEvents(): Map<string, string[]> {
  const src = readFileSync(SOURCE, "utf8").replace(/\/\/\/?.*$/gm, "");
  const out = new Map<string, string[]>();
  for (const m of src.matchAll(/event\s+(\w+)\s*\(([^)]*)\)/g)) {
    const params = m[2]
      .split(",")
      .map((p) => p.trim().replace(/\s+/g, " "))
      .filter(Boolean)
      .map((p) => p.replace(/^Id /, "bytes32 ").replace(/^MarketParams /, "tuple "));
    out.set(m[1], params);
  }
  return out;
}

describe("Morpho Blue event ABI (SI-R1)", () => {
  it("SI_R1 matches EventsLib.sol v1.0.0 name, types, indexing and order for every indexed event", () => {
    const sol = solidityEvents();
    for (const e of morphoEventsAbi) {
      const expected = sol.get(e.name);
      expect(expected, e.name).toBeDefined();
      const ours = e.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`);
      expect(ours, e.name).toEqual(expected);
    }
  });
});
