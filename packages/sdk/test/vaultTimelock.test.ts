import {describe, expect, it} from "vitest";
import {decodeFunctionData} from "viem";
import {getDeployment} from "../src/addresses.js";
import {vaultV2FullAbi} from "../src/abis.js";
import {vaultCuratorOperation} from "../src/vaultTimelock.js";

const d = getDeployment(31337)!;

/** FE-R1: Vault V2 curator actions go through the vault's own timelock (submit → wait → anyone calls); rehearsed
 * against the real vault on anvil in packages/devnet/test/runbooks.test.ts. */
describe("vault curator calldata (FE-R1)", () => {
  it("submit / revoke wrap the exact timelocked call on the ticker's vault", () => {
    const op = vaultCuratorOperation(d, {kind: "vault.setPerformanceFeeRecipient", ticker: "NVDA", recipient: d.feeSplitter!});
    expect(op.vault).toBe(d.stocks.NVDA.vault);
    const inner = decodeFunctionData({abi: vaultV2FullAbi, data: op.data});
    expect(inner.functionName).toBe("setPerformanceFeeRecipient");
    expect(inner.args).toEqual([d.feeSplitter]);
    expect(decodeFunctionData({abi: vaultV2FullAbi, data: op.submitCalldata})).toMatchObject({functionName: "submit", args: [op.data]});
    expect(decodeFunctionData({abi: vaultV2FullAbi, data: op.revokeCalldata})).toMatchObject({functionName: "revoke", args: [op.data]});
  });

  it("encodes the fee and refuses what Vault V2 would reject", () => {
    const op = vaultCuratorOperation(d, {kind: "vault.setPerformanceFee", ticker: "AAPL", feeWad: 10n ** 17n});
    expect(decodeFunctionData({abi: vaultV2FullAbi, data: op.data}).args).toEqual([10n ** 17n]);
    expect(() => vaultCuratorOperation(d, {kind: "vault.setPerformanceFee", ticker: "AAPL", feeWad: 6n * 10n ** 17n})).toThrow(/MAX_PERFORMANCE_FEE/);
    expect(() => vaultCuratorOperation(d, {kind: "vault.setPerformanceFeeRecipient", ticker: "AAPL", recipient: `0x${"0".repeat(40)}`})).toThrow(/address\(0\)/);
    expect(() => vaultCuratorOperation(d, {kind: "vault.setPerformanceFee", ticker: "TSLA", feeWad: 1n})).toThrow(/unknown ticker/);
  });
});
