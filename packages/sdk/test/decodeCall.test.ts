import {describe, expect, it} from "vitest";
import {encodeFunctionData, getAddress} from "viem";
import {getDeployment} from "../src/addresses.js";
import {deltaNeutralVaultAbi, navOracleAbi, lendoraOracleAbi, lendoraRouterAbi, strategyManagerAbi, vaultV2FullAbi} from "../src/abis.js";
import {decodeLendoraCall} from "../src/decodeCall.js";

const d = getDeployment(31337)!;

/** MON-R16/R17: pages carry the scheduled call decoded against the Lendora contract it targets. */
describe("decodeLendoraCall (MON-R16)", () => {
  it("labels the target and decodes the call", () => {
    const signer = "0x00000000000000000000000000000000000000aa" as const;
    const r = decodeLendoraCall(d, d.router!, encodeFunctionData({abi: lendoraRouterAbi, functionName: "setAttestationSigner", args: [signer]}));
    expect(r.summary).toBe(`router.setAttestationSigner(${getAddress(signer)})`);
    const o = decodeLendoraCall(d, d.stocks.NVDA.oracle, encodeFunctionData({abi: lendoraOracleAbi, functionName: "resetReferences"}));
    expect(o.label).toBe("oracle:NVDA");
    expect(o.functionName).toBe("resetReferences");
    const v = decodeLendoraCall(d, d.stocks.AAPL.vault, encodeFunctionData({abi: vaultV2FullAbi, functionName: "setPerformanceFee", args: [10n ** 17n]}));
    expect(v.summary).toBe("vault:AAPL.setPerformanceFee(100000000000000000)");
  });

  it("Phase 4: the DN vault, its strategy and NAV oracle, and the receipt market's oracle and USDG vault are decoded", () => {
    const dn = d.dnVault!;
    expect(decodeLendoraCall(d, dn.vault, encodeFunctionData({abi: deltaNeutralVaultAbi, functionName: "setTotalCap", args: [10n ** 12n]})).summary).toBe("dnVault.setTotalCap(1000000000000)");
    expect(decodeLendoraCall(d, dn.strategy, encodeFunctionData({abi: strategyManagerAbi, functionName: "setSleeveCap", args: [1n, 5n]})).summary).toBe("dnStrategy.setSleeveCap(1, 5)");
    const signer = "0x00000000000000000000000000000000000000bb" as const;
    expect(decodeLendoraCall(d, dn.navOracle, encodeFunctionData({abi: navOracleAbi, functionName: "setSigner", args: [signer, true]})).summary).toBe(`navOracle.setSigner(${getAddress(signer)}, true)`);
    const rc = d.stocks.NVDA.receipt!;
    expect(decodeLendoraCall(d, rc.usdgVault, encodeFunctionData({abi: vaultV2FullAbi, functionName: "setPerformanceFee", args: [0n]})).label).toBe("receiptVault:NVDA");
    expect(decodeLendoraCall(d, rc.oracle, encodeFunctionData({abi: lendoraOracleAbi, functionName: "resetReferences"})).summary).toBe("receiptOracle:NVDA.resetReferences()");
  });

  it("never throws on unknown targets or selectors", () => {
    expect(decodeLendoraCall(d, "0x0000000000000000000000000000000000000001", "0xdeadbeef").label).toBe("unknown");
    expect(decodeLendoraCall(d, d.router!, "0xdeadbeef").functionName).toBeNull();
    expect(decodeLendoraCall(d, d.timelock, "0xdeadbeef").label).toBe("timelock");
  });
});
