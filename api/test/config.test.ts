import {describe, expect, it} from "vitest";
import {loadConfig} from "../src/config.js";

describe("API startup network (MN-R6)", () => {
  it("MN_R6 refuses mainnet (4663) until addresses.json has it, with no Phase 2 blanket refusal", () => {
    expect(() => loadConfig({LENDORA_NETWORK: "4663", DATABASE_URL: "postgres://x"})).toThrow(/api: no deployment "4663".*MN-R6/);
    expect(() => loadConfig({LENDORA_NETWORK: "4663", DATABASE_URL: "postgres://x"})).not.toThrow(/Phase 2/);
  });
  it("MN_R6 serves the fork of 4663 with chain id 4663, and testnet", () => {
    expect(loadConfig({LENDORA_NETWORK: "fork-4663", DATABASE_URL: "postgres://x"}).chainId).toBe(4663);
    expect(loadConfig({LENDORA_NETWORK: "46630", DATABASE_URL: "postgres://x"}).chainId).toBe(46630);
    expect(() => loadConfig({LENDORA_NETWORK: "banana", DATABASE_URL: "postgres://x"})).toThrow(/invalid network/);
  });
});
