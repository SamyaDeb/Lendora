import {describe, expect, it} from "vitest";
import {networkConfig} from "../lib/network.js";

describe("indexer network (MN-R6)", () => {
  it("MN_R6 refuses mainnet (4663) until addresses.json has it; no Phase 2 blanket refusal", () => {
    expect(() => networkConfig({LENDORA_NETWORK: "4663"})).toThrow(/indexer: no deployment "4663".*MN-R6/);
  });
  it("MN_R6 the fork of 4663 indexes the real Uniswap pools (the same branch mainnet takes)", () => {
    const n = networkConfig({LENDORA_NETWORK: "fork-4663", RPC_URL: "http://x"});
    expect(n.chainId).toBe(4663);
    expect(n.dexKind).toBe("uniswap");
    expect(networkConfig({LENDORA_NETWORK: "46630", RPC_URL: "http://x"}).dexKind).toBe("mock");
  });
  it("T3 INDEXER_RPC_URL gives the indexer its own RPC; the archive fallback for pinned reads is kept", () => {
    const shared = networkConfig({LENDORA_NETWORK: "46630", RPC_URL: "http://shared", RPC_URL_ARCHIVE: "http://archive"});
    expect(shared.rpcUrl).toBe("http://shared");
    const own = networkConfig({LENDORA_NETWORK: "46630", RPC_URL: "http://shared", INDEXER_RPC_URL: "http://indexer", RPC_URL_ARCHIVE: "http://archive"});
    expect(own.rpcUrl).toBe("http://indexer");
    expect(own.archiveRpcUrl).toBe("http://archive");
    expect(networkConfig({LENDORA_NETWORK: "46630", RPC_URL: "http://shared", INDEXER_RPC_URL: ""}).rpcUrl).toBe("http://shared");
  });
});
