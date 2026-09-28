import {describe, expect, it} from "vitest";
import {getDeployment, type ChainDeployment} from "@stockline/sdk";
import {devPagesEnabled, faucetKind, isTestChain, webDeployment} from "@/lib/network";
import {geoPlatform} from "@/lib/complianceProxy";

const local = getDeployment(31337)!;
const testnet = getDeployment(46630)!;
/** A mainnet deployment as the launcher will publish it: no mocks, no faucet. */
const mainnet: ChainDeployment = {...local, mocks: undefined};

describe("MN-R6 the web app serves mainnet only once addresses.json has it", () => {
  it("MN_R6 refuses 4663 while unpublished and serves it once published", () => {
    expect(() => webDeployment(4663)).toThrow(/web: no deployment "4663".*MN-R6/);
    expect(webDeployment(4663, (k) => (k === 4663 ? mainnet : undefined))).toBe(mainnet);
    expect(webDeployment(46630)).toBe(testnet);
  });

  it("MN_R6 never offers test funds on mainnet, even if a deployment carried a faucet", () => {
    expect(faucetKind(4663, {...mainnet, mocks: {faucet: "0x0000000000000000000000000000000000000001"}}, "http://x")).toBeNull();
    expect(isTestChain(4663, {...mainnet, mocks: {faucet: "0x0000000000000000000000000000000000000001"}})).toBe(false);
    expect(faucetKind(46630, testnet)).toBe("testnet");
    expect(faucetKind(31337, local, "http://127.0.0.1:8545")).toBe("local");
    expect(isTestChain(31337, local)).toBe(true);
  });

  it("MN_R6 dev pages are off on mainnet even with NEXT_PUBLIC_DEV_PAGES=1", () => {
    expect(devPagesEnabled({NODE_ENV: "production", NEXT_PUBLIC_DEV_PAGES: "1", NEXT_PUBLIC_CHAIN_ID: "4663"})).toBe(false);
    expect(devPagesEnabled({NODE_ENV: "development", NEXT_PUBLIC_CHAIN_ID: "4663"})).toBe(false);
    expect(devPagesEnabled({NODE_ENV: "production", NEXT_PUBLIC_DEV_PAGES: "1", NEXT_PUBLIC_CHAIN_ID: "46630"})).toBe(true);
    expect(devPagesEnabled({NODE_ENV: "production"})).toBe(false);
    expect(devPagesEnabled({NODE_ENV: "development"})).toBe(true);
  });

  it("MN_R6 static geo is refused on mainnet", () => {
    expect(() => geoPlatform("static", {NODE_ENV: "development", NEXT_PUBLIC_CHAIN_ID: "4663", GEO_STATIC_COUNTRY: "DE"} as NodeJS.ProcessEnv)).toThrow(/mainnet/);
  });
});
