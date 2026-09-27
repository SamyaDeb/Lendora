import {describe, expect, it} from "vitest";
import {getDeployment} from "../src/addresses.js";
import {capIds, marketIdOf, marketParamsOf} from "../src/encoding.js";

describe("onchain encodings", () => {
  it("LM-R10 marketIdOf and capIds reproduce the ids DeployLocal wrote to addresses.json", () => {
    const d = getDeployment(31337)!;
    for (const s of Object.values(d.stocks)) {
      const p = marketParamsOf(d, s);
      expect(marketIdOf(p)).toBe(s.marketId);
      expect(capIds(s.adapter, p)[2]).toBe(s.adapterMarketCapId);
    }
  });
});
