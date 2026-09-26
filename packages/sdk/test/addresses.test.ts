import {describe, expect, it} from "vitest";
import {deploymentKeys, getDeployment} from "../src/addresses.js";

describe("addresses.json (LM-R10)", () => {
  it("never contains the real Robinhood Chain key in Phase 1", () => {
    expect(deploymentKeys).not.toContain("4663");
    expect(deploymentKeys).not.toContain("46630");
  });

  it("every deployment lists three stocks with vault, adapter and market ids", () => {
    for (const key of deploymentKeys) {
      const d = getDeployment(key === "fork-4663" ? key : Number(key))!;
      expect(Object.keys(d.stocks).sort(), key).toEqual(["AAPL", "NVDA", "SPY"]);
      for (const s of Object.values(d.stocks)) {
        expect(s.vault).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(s.adapter).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(s.marketId).toMatch(/^0x[0-9a-f]{64}$/);
        expect(BigInt(s.lltv)).toBe(770000000000000000n);
      }
      expect(d.roles.guardian).toMatch(/^0x/);
    }
  });
});
