import {describe, expect, it} from "vitest";
import {encodeFunctionData, getAddress} from "viem";
import {getDeployment} from "../src/addresses.js";
import {deltaNeutralVaultAbi, navOracleAbi, stocklineOracleAbi, stocklineRouterAbi, strategyManagerAbi, vaultV2FullAbi} from "../src/abis.js";
import {decodeStocklineCall} from "../src/decodeCall.js";

const d = getDeployment(31337)!;

/** MON-R16/R17: pages carry the scheduled call decoded against the Stockline contract it targets. */
describe("decodeStocklineCall (MON-R16)", () => {
  it("labels the target and decodes the call", () => {
    const signer = "0x00000000000000000000000000000000000000aa" as const;
    const r = decodeStocklineCall(d, d.router!, encodeFunctionData({abi: stocklineRouterAbi, functionName: "setAttestationSigner", args: [signer]}));
    expect(r.summary).toBe(`router.setAttestationSigner(${getAddress(signer)})`);
    const o = decodeStocklineCall(d, d.stocks.NVDA.oracle, encodeFunctionData({abi: stocklineOracleAbi, functionName: "resetReferences"}));
    expect(o.label).toBe("oracle:NVDA");
    expect(o.functionName).toBe("resetReferences");
    const v = decodeStocklineCall(d, d.stocks.AAPL.vault, encodeFunctionData({abi: vaultV2FullAbi, functionName: "setPerformanceFee", args: [10n ** 17n]}));
    expect(v.summary).toBe("vault:AAPL.setPerformanceFee(100000000000000000)");
  });

  it("Phase 4: the DN vault, its strategy and NAV oracle, and the receipt market's oracle and USDG vault are decoded", () => {
    const dn = d.dnVault!;
    expect(decodeStocklineCall(d, dn.vault, encodeFunctionData({abi: deltaNeutralVaultAbi, functionName: "setTotalCap", args: [10n ** 12n]})).summary).toBe("dnVault.setTotalCap(1000000000000)");
    expect(decodeStocklineCall(d, dn.strategy, encodeFunctionData({abi: strategyManagerAbi, functionName: "setSleeveCap", args: [1n, 5n]})).summary).toBe("dnStrategy.setSleeveCap(1, 5)");
    const signer = "0x00000000000000000000000000000000000000bb" as const;
    expect(decodeStocklineCall(d, dn.navOracle, encodeFunctionData({abi: navOracleAbi, functionName: "setSigner", args: [signer, true]})).summary).toBe(`navOracle.setSigner(${getAddress(signer)}, true)`);
    const rc = d.stocks.NVDA.receipt!;
    expect(decodeStocklineCall(d, rc.usdgVault, encodeFunctionData({abi: vaultV2FullAbi, functionName: "setPerformanceFee", args: [0n]})).label).toBe("receiptVault:NVDA");
    expect(decodeStocklineCall(d, rc.oracle, encodeFunctionData({abi: stocklineOracleAbi, functionName: "resetReferences"})).summary).toBe("receiptOracle:NVDA.resetReferences()");
  });

  it("never throws on unknown targets or selectors", () => {
    expect(decodeStocklineCall(d, "0x0000000000000000000000000000000000000001", "0xdeadbeef").label).toBe("unknown");
    expect(decodeStocklineCall(d, d.router!, "0xdeadbeef").functionName).toBeNull();
    expect(decodeStocklineCall(d, d.timelock, "0xdeadbeef").label).toBe("timelock");
  });
});
