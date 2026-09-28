import {describe, expect, it} from "vitest";
import {networkConfig} from "../lib/network.js";

describe("indexer network (MN-R6)", () => {
  it("MN_R6 refuses mainnet (4663) until addresses.json has it; no Phase 2 blanket refusal", () => {
    expect(() => networkConfig({STOCKLINE_NETWORK: "4663"})).toThrow(/indexer: no deployment "4663".*MN-R6/);
  });
  it("MN_R6 the fork of 4663 indexes the real Uniswap pools (the same branch mainnet takes)", () => {
    const n = networkConfig({STOCKLINE_NETWORK: "fork-4663", RPC_URL: "http://x"});
    expect(n.chainId).toBe(4663);
    expect(n.dexKind).toBe("uniswap");
    expect(networkConfig({STOCKLINE_NETWORK: "46630", RPC_URL: "http://x"}).dexKind).toBe("mock");
  });
});
