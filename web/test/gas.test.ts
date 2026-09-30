import {describe, expect, it, vi} from "vitest";
import type {PublicClient, WalletClient} from "viem";
import {GAS_HEADROOM_PCT, WITHDRAW_LEND_MIN_GAS, simulateAndSend} from "@/lib/tx";

/**
 * Found by testnetBreak on 46630: a router `lend` sent with the bare gas estimate ran out of gas on-chain (326,005 of
 * 332,112, tx 0x39195c93…), because on Robinhood Chain (Arbitrum Orbit) part of the gas pays the L1 data fee, which
 * moves between estimation and inclusion. The app sends every transaction with headroom and names an out-of-gas
 * failure instead of a bare "transaction reverted".
 */
const call = {address: "0x0000000000000000000000000000000000000001", abi: [], functionName: "lend", args: []} as never;
const account = "0x0000000000000000000000000000000000000002" as const;

function clients(estimate: bigint, receipt: {status: "success" | "reverted"; gasUsed: bigint}) {
  const request = {address: "0x1", functionName: "lend"};
  const pc = {
    simulateContract: vi.fn().mockResolvedValue({request}),
    estimateContractGas: vi.fn().mockResolvedValue(estimate),
    waitForTransactionReceipt: vi.fn().mockResolvedValue(receipt),
  } as unknown as PublicClient;
  const wc = {writeContract: vi.fn().mockResolvedValue("0xhash")} as unknown as WalletClient;
  return {pc, wc};
}

describe("gas headroom for the L1 data fee (Arbitrum Orbit)", () => {
  it("sends with the estimate plus headroom", async () => {
    const {pc, wc} = clients(300_000n, {status: "success", gasUsed: 290_000n});
    await simulateAndSend(pc, wc, account, call);
    expect((wc.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0].gas).toBe((300_000n * (100n + GAS_HEADROOM_PCT)) / 100n);
    expect(GAS_HEADROOM_PCT).toBeGreaterThanOrEqual(25n);
  });

  it("an out-of-gas failure says so (and that retrying is safe)", async () => {
    const limit = (300_000n * (100n + GAS_HEADROOM_PCT)) / 100n;
    const {pc, wc} = clients(300_000n, {status: "reverted", gasUsed: limit - 100n});
    await expect(simulateAndSend(pc, wc, account, call)).rejects.toThrow(/ran out of gas.*retry/i);
  });

  it("T33 a call whose path can change before inclusion carries a gas floor (withdrawLend: idle → deallocation)", async () => {
    // 46630: estimated on the idle path (215,630), mined after the allocator moved the idle into Morpho: the
    // deallocation path needed > 276,432 of the 280,320 limit (tx 0x0b882ead…). That path measures 372,545.
    const {pc, wc} = clients(215_630n, {status: "success", gasUsed: 372_545n});
    await simulateAndSend(pc, wc, account, {...(call as object), minGas: WITHDRAW_LEND_MIN_GAS} as never);
    expect((wc.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0].gas).toBe(WITHDRAW_LEND_MIN_GAS);
    expect(WITHDRAW_LEND_MIN_GAS * 10n).toBeGreaterThanOrEqual(372_545n * 13n);
    // A floor never lowers a larger estimate's headroom.
    const big = clients(600_000n, {status: "success", gasUsed: 590_000n});
    await simulateAndSend(big.pc, big.wc, account, {...(call as object), minGas: WITHDRAW_LEND_MIN_GAS} as never);
    expect((big.wc.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0].gas).toBe((600_000n * (100n + GAS_HEADROOM_PCT)) / 100n);
  });

  it("T33 out of gas is explained without blaming the fee alone (the state can change too)", async () => {
    const limit = (300_000n * (100n + GAS_HEADROOM_PCT)) / 100n;
    const {pc, wc} = clients(300_000n, {status: "reverted", gasUsed: limit - 100n});
    await expect(simulateAndSend(pc, wc, account, call)).rejects.toThrow(/ran out of gas: the market changed while it was pending/i);
  });

  it("T38 the network failing after the send says it was sent (check before retrying), not 'nothing was sent'", async () => {
    const {pc, wc} = clients(300_000n, {status: "success", gasUsed: 1n});
    (pc.waitForTransactionReceipt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("HTTP request failed."));
    await expect(simulateAndSend(pc, wc, account, call)).rejects.toThrow(/was sent \(0xhash/);
  }, 15_000);

  it("T38 a short RPC error while waiting for the receipt is ridden out (46630 row 13: withdraw sent, one poll failed)", async () => {
    const {pc, wc} = clients(300_000n, {status: "success", gasUsed: 1n});
    (pc.waitForTransactionReceipt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("HTTP request failed.")).mockResolvedValueOnce({status: "success", gasUsed: 1n});
    await expect(simulateAndSend(pc, wc, account, call)).resolves.toBe("0xhash");
  });
});
