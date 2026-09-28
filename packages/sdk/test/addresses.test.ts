import {describe, expect, it} from "vitest";
import {chainIdOf, deploymentKeys, getDeployment, isRobinhoodMainnet, resolveDeployment} from "../src/addresses.js";

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

describe("resolveDeployment (MN-R6)", () => {
  const fake = {...getDeployment(31337)!};
  it("MN_R6 serves 4663 once addresses.json has it, with chain id 4663", () => {
    const r = resolveDeployment("4663", "api", (k) => (k === 4663 ? fake : undefined));
    expect(r.chainId).toBe(4663);
    expect(isRobinhoodMainnet(r.key)).toBe(true);
  });
  it("MN_R6 refuses 4663 while it is not published, naming the service", () => {
    expect(() => resolveDeployment("4663", "web")).toThrow(/web: no deployment "4663".*MN-R6/);
  });
  it("MN_R6 refuses garbage keys and resolves the fork and testnet", () => {
    expect(() => resolveDeployment("abc", "x")).toThrow(/invalid network/);
    expect(resolveDeployment("fork-4663", "x").chainId).toBe(4663);
    expect(resolveDeployment("46630", "x").chainId).toBe(46630);
    expect(isRobinhoodMainnet(46630)).toBe(false);
    expect(chainIdOf(31337)).toBe(31337);
  });
});
