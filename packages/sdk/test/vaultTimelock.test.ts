import {describe, expect, it} from "vitest";
import {decodeFunctionData} from "viem";
import {getDeployment} from "../src/addresses.js";
import {vaultV2FullAbi} from "../src/abis.js";
import {receiptListingOperations, receiptMarketCapId, vaultCuratorOperation} from "../src/vaultTimelock.js";

const RECEIPT_CAP_ID_VECTOR = "0xa375cf5a1815482cc748bf2e244ec447d687f4a44f0d7a404b3f082f83fe9654";

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

describe("G5 receipt market listing (A3, CL-R10)", () => {
  const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
  const rd = {
    ...d,
    usdg: A(0x11),
    adaptiveCurveIrm: A(0x44),
    stocks: {...d.stocks, NVDA: {...d.stocks.NVDA, vault: A(0x22), receipt: {oracle: A(0x33), usdgVault: A(0x55), usdgAdapter: A(0x66), marketId: `0x${"0".repeat(64)}` as const, adapterMarketCapId: `0x${"0".repeat(64)}` as const, lltv: "625000000000000000"}}},
  };

  it("A3 encodes six curator calls: absolute and relative caps on the adapter, collateral and market ids", () => {
    const ops = receiptListingOperations(rd, "NVDA", 250_000n * 10n ** 6n, {chainId: 46630});
    expect(ops).toHaveLength(6);
    expect(ops.every((o) => o.vault === A(0x55))).toBe(true);
    const abs = decodeFunctionData({abi: vaultV2FullAbi, data: ops[0].data});
    expect(abs.functionName).toBe("increaseAbsoluteCap");
    expect(abs.args?.[1]).toBe(250_000_000_000n);
    expect(decodeFunctionData({abi: vaultV2FullAbi, data: ops[5].data}).args?.[1]).toBe(10n ** 18n);
    expect(decodeFunctionData({abi: vaultV2FullAbi, data: ops[0].submitCalldata})).toMatchObject({functionName: "submit", args: [ops[0].data]});
  });

  it("A3 the market cap id matches VaultV2Ids.marketId in Solidity (shared vector)", () => {
    // Same vector as test_G5_capIdVectorMatchesSdk in contracts/test/deploy/ReceiptMarket.t.sol.
    expect(receiptMarketCapId(rd, "NVDA")).toBe(RECEIPT_CAP_ID_VECTOR);
  });

  it("CL_R10 refuses on 4663 without launchTs or before launch + 30 days; needs a receipt deployment", () => {
    expect(() => receiptListingOperations(rd, "NVDA", 1n, {chainId: 4663})).toThrow(/launchTs/);
    expect(() => receiptListingOperations(rd, "NVDA", 1n, {chainId: 4663, launchTs: 1000, nowTs: 1000 + 30 * 86_400 - 1})).toThrow(/30 days/);
    expect(receiptListingOperations(rd, "NVDA", 1n, {chainId: 4663, launchTs: 1000, nowTs: 1000 + 30 * 86_400})).toHaveLength(6);
    const noReceipt = {...d, stocks: {...d.stocks, NVDA: {...d.stocks.NVDA, receipt: undefined}}}; // the 31337 book has one since task 15
    expect(() => receiptListingOperations(noReceipt, "NVDA", 1n, {chainId: 31337})).toThrow(/no receipt market/);
    expect(() => receiptListingOperations(rd, "NVDA", 0n, {chainId: 31337})).toThrow(/> 0/);
  });
});
