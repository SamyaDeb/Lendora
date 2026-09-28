import {describe, expect, it} from "vitest";
import {BaseError, encodeErrorResult, type Abi, type AbiParameter} from "viem";
import {collateralTokenAbi, deltaNeutralVaultAbi, feeConverterAbi, feeSplitterAbi, marketHoursAbi, navOracleAbi, stocklineLiquidatorAbi, stocklineOracleAbi, stocklineRouterAbi, stockWrapperAbi, strategyManagerAbi} from "@stockline/sdk";
import {explainError} from "@/lib/errors";
import {contentSecurityPolicy, securityHeaders} from "@/lib/csp";
import {MAX_KEYS, POST as analytics, GET as analyticsCounts} from "@/app/api/analytics/route";

class Wrapped extends BaseError {
  constructor(readonly data: `0x${string}`) {
    super("execution reverted");
  }
}

/** Zero values for any ABI parameter, so every custom error can be encoded. */
function zero(p: AbiParameter): unknown {
  if (p.type.endsWith("]")) return [];
  if (p.type === "tuple") return Object.fromEntries(((p as unknown as {components?: AbiParameter[]}).components ?? []).map((c) => [c.name, zero(c)]));
  if (p.type === "address") return "0x0000000000000000000000000000000000000000";
  if (p.type === "bool") return false;
  if (p.type.startsWith("bytes")) return p.type === "bytes" ? "0x" : `0x${"00".repeat(Number(p.type.slice(5)))}`;
  if (p.type === "string") return "";
  return 0n;
}

describe("OFF-14 the revert decoder covers every Stockline custom error", () => {
  const stockline: [string, Abi][] = [
    ["router", stocklineRouterAbi as Abi],
    ["wrapper", stockWrapperAbi as Abi],
    ["clUSDG", collateralTokenAbi as Abi],
    ["oracle", stocklineOracleAbi as Abi],
    ["MarketHours", marketHoursAbi as Abi],
    ["liquidator", stocklineLiquidatorAbi as Abi],
    ["FeeSplitter", feeSplitterAbi as Abi],
    ["FeeConverter", feeConverterAbi as Abi],
    ["DeltaNeutralVault", deltaNeutralVaultAbi as Abi],
    ["StrategyManager", strategyManagerAbi as Abi],
    ["NavOracle", navOracleAbi as Abi],
  ];
  it("OFF_14 every error decodes by name (never raw hex), including the fee contracts'", () => {
    let n = 0;
    for (const [label, abi] of stockline) {
      for (const e of abi.filter((x) => x.type === "error") as {name: string; inputs: readonly AbiParameter[]}[]) {
        const data = encodeErrorResult({abi, errorName: e.name, args: e.inputs.map(zero)} as never);
        const msg = explainError(new Wrapped(data));
        expect(msg, `${label}.${e.name}`).not.toMatch(/0x[0-9a-f]{8}/i);
        expect(msg, `${label}.${e.name}`).not.toBe("execution reverted");
        n++;
      }
    }
    expect(n).toBeGreaterThan(80);
  });

  it("OFF_14 USDG Earn errors have plain-language text, and exits are named as still working", () => {
    const enc = (errorName: string) => {
      const e = (deltaNeutralVaultAbi as Abi).find((x) => x.type === "error" && x.name === errorName) as unknown as {inputs: readonly AbiParameter[]};
      return new Wrapped(encodeErrorResult({abi: deltaNeutralVaultAbi, errorName, args: e.inputs.map(zero)} as never));
    };
    expect(explainError(enc("NavStale"))).toMatch(/Request a withdrawal instead/);
    expect(explainError(enc("DepositsPaused"))).toMatch(/Withdrawals and claims still work/);
    expect(explainError(enc("ExceedsInstant"))).toMatch(/Request a withdrawal for the rest/);
    expect(explainError(enc("CapExceeded"))).toMatch(/cap/);
    expect(explainError(enc("MarketClosed"))).toMatch(/requests and claims still work/);
    expect(explainError(enc("NotClaimable"))).toMatch(/isn't ready/);
  });

  it("OFF_14 fee-path errors have plain-language text", () => {
    const enc = (errorName: string) => {
      const e = (feeConverterAbi as Abi).find((x) => x.type === "error" && x.name === errorName) as unknown as {inputs: readonly AbiParameter[]};
      return new Wrapped(encodeErrorResult({abi: feeConverterAbi, errorName, args: e.inputs.map(zero)} as never));
    };
    expect(explainError(enc("SlippageTooLoose"))).toMatch(/1% below the oracle/);
    expect(explainError(enc("NotKeeper"))).toMatch(/reserved to a Stockline role/);
    expect(explainError(enc("MarketClosed"))).toMatch(/session is closed/);
  });
});

describe("OFF-12 CSP and HSTS", () => {
  it("OFF_12 the policy locks scripts, framing and connections to the listed origins", () => {
    const csp = contentSecurityPolicy({NODE_ENV: "production", NEXT_PUBLIC_API_URL: "https://api.stockline.xyz", NEXT_PUBLIC_RPC_URL: "https://rpc.testnet.chain.robinhood.com", NEXT_PUBLIC_CHAIN_ID: "46630"});
    const dir = Object.fromEntries(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
    expect(dir["default-src"]).toEqual(["'self'"]);
    expect(dir["script-src"]).not.toContain("'unsafe-eval'");
    expect(dir["frame-ancestors"]).toEqual(["'none'"]);
    expect(dir["object-src"]).toEqual(["'none'"]);
    expect(dir["connect-src"]).toEqual(expect.arrayContaining(["https://api.stockline.xyz", "wss://api.stockline.xyz", "https://rpc.testnet.chain.robinhood.com"]));
    expect(dir["connect-src"].some((o: string) => o.includes("*") && !/walletconnect|web3modal|reown|coinbase/.test(o))).toBe(false);
    const h = securityHeaders({NODE_ENV: "production"});
    expect(h.find((x) => x.key === "Strict-Transport-Security")?.value).toMatch(/max-age=63072000/);
    expect(securityHeaders({NODE_ENV: "development"}).some((x) => x.key === "Strict-Transport-Security")).toBe(false);
    expect(contentSecurityPolicy({NODE_ENV: "development"})).toContain("'unsafe-eval'"); // React refresh, dev only
  });
});

describe("OFF-13 analytics counters are bounded", () => {
  it("OFF_13 distinct keys stop growing at MAX_KEYS", async () => {
    const post = (path: string) => analytics(new Request("http://x/api/analytics", {method: "POST", body: JSON.stringify({event: "page", path})}));
    for (let i = 0; i < MAX_KEYS + 500; i++) await post(`/p${i}`);
    const counts = (await (await analyticsCounts()).json()) as Record<string, number>;
    expect(Object.keys(counts).length).toBeLessThanOrEqual(MAX_KEYS);
  });
});
