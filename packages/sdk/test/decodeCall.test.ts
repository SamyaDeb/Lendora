import {describe, expect, it} from "vitest";
import {encodeFunctionData, getAddress} from "viem";
import {getDeployment} from "../src/addresses.js";
import {stocklineOracleAbi, stocklineRouterAbi, vaultV2FullAbi} from "../src/abis.js";
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

  it("never throws on unknown targets or selectors", () => {
    expect(decodeStocklineCall(d, "0x0000000000000000000000000000000000000001", "0xdeadbeef").label).toBe("unknown");
    expect(decodeStocklineCall(d, d.router!, "0xdeadbeef").functionName).toBeNull();
    expect(decodeStocklineCall(d, d.timelock, "0xdeadbeef").label).toBe("timelock");
  });
});
