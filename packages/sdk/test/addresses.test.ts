import {describe, expect, it} from "vitest";
import {deploymentKeys, getDeployment} from "../src/addresses.js";

describe("addresses.json (LM-R10)", () => {
  it("never contains Robinhood Chain mainnet (4663) before the Phase 3 mainnet launch", () => {
    expect(deploymentKeys).not.toContain("4663");
  });

  it("testnet (46630, deployed 2026-09-28 on the owner's go) has the router, timelock, lens and faucet", () => {
    const d = getDeployment(46630)!;
    for (const a of [d.router, d.timelock, d.lens, d.mocks?.faucet]) expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
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
